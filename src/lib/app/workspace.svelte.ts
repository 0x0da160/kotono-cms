/**
 * 作業フォルダ全体の状態と操作（仕様 3・10.1・11・12・13・23）。
 */
import { allocateArticleId, generateArticleId } from "../core/article-id";
import {
  analyzeText,
  duplicateText,
  newArticleText,
  proposeCreatedAtFix,
  proposeIdFix,
  type RepairProposal,
  textFromBytes,
  unknownKeys,
  verifyCandidateBytes,
  type Problem,
} from "../core/article-doc";
import { IMAGE_TASK_MAX_MS } from "../core/budgets";
import { bytesEqual, encodeUtf8, sha256Hex } from "../core/bytes";
import { isValidDateTime, nowDateTime } from "../core/datetime";
import { imageMarkdown } from "../core/image";
import { refsFromTree, type MediaRefs } from "../core/markdown";
import { unavailableMdService, type MdService } from "../parse/md-service";
import { checkSlugUniqueness } from "../core/slug";
import type { DraftRecord } from "../drafts/store";
import { deleteEntries, duplicateArticle } from "../fs/article-ops";
import { createBackup, itemsFromTree, type BackupItem } from "../fs/backup";
import {
  browserDecoder,
  effectiveLimits,
  listMedia,
  MEDIA_DIR,
  saveMedia,
  saveVariants,
  listVariants,
  withTimeout,
  validateImport,
  type Decoder,
  type MediaFile,
} from "../fs/media";
import { enumerateTree, fingerprint, readAllBytes, sameFingerprints, type Fingerprint } from "../fs/tree";
import { DraftController } from "./drafts.svelte";
import {
  canCreateArticles,
  canImportMedia,
  createArticlesDir,
  openArticlesDir,
  readArticle,
  readConfig,
  readEntryMeta,
  scanArticles,
  slugEntries,
  ARTICLES_PATH,
  type ListEntry,
  type RepoConfig,
  type ScanResult,
} from "../fs/repo";
import {
  createArticle,
  ensureWritePermission,
  readDiskArticle,
  saveExisting,
  SerialQueue,
  type DiskClass,
} from "../fs/save";
import { classifyFsError, fsErrorMessage, type DirHandleLike } from "../fs/types";
import { EditorSession, problemsNotice, type Notice } from "./session.svelte";
import { looksLikeDirHandle, type RecentFolderStore } from "./recent-folder";
import {
  browserProcessor,
  mediaIdOf,
  VARIANTS_DIR,
  type EncodedVariant,
  type ImageProcessor,
  type ProcessResult,
} from "../fs/optimize";
import type { ImageInfo } from "../core/image";

/**
 * 保存の前に外部変更を検出したときの通知の文言。編集画面は、外部変更パネルが出ている間、
 * この通知を別の枠に出さず、パネルの見出しで伝える（UI刷新 P-08：二重表示をやめる。文言・状態は変えない）。
 */
export const EXTERNAL_CHANGE_NOTICE =
  "外部変更あり：読み込み後にディスク上のファイルが変わったため、保存を止めました。";

export interface DialogButton {
  readonly label: string;
  readonly value: string;
  readonly variant?: "primary" | "danger" | "default";
}

export interface DialogRequest {
  readonly title: string;
  readonly message: string;
  readonly details?: readonly string[];
  readonly buttons: readonly DialogButton[];
  /** 初期フォーカスを置くボタン（危険操作を既定にしない：14.1） */
  readonly initial: string;
  readonly resolve: (value: string) => void;
}

type BuildCandidate = () => { ok: true; bytes: Uint8Array } | { ok: false; problems: Problem[] };

type PickerHost = {
  showDirectoryPicker?: (o?: { mode?: "read" | "readwrite"; id?: string; startIn?: string }) => Promise<unknown>;
};

/** Git 機能との連携（20.3・19・22）。Git 未使用・判定前は null */
export interface GitHooks {
  /** 未解決の競合など、記事を読み取り専用にする理由 */
  readOnlyReason(id: string): string | null;
  /** 記事フォルダ内のファイルの Git 状態の説明（削除・画像削除の確認に使う：19） */
  describe(id: string, relPaths?: readonly string[]): Promise<string[]>;
  /** 記事の内容がディスク上で変わった（保存・複製・削除・画像の取り込み） */
  changed(id: string): void;
}

export interface WorkspaceOptions {
  readonly drafts?: DraftController | null;
  readonly decoder?: Decoder;
  /** Markdown 解析（ブラウザでは Worker）。未指定なら解析不能として扱う */
  readonly md?: MdService;
  readonly appVersion?: string;
  readonly specVersion?: string;
  /** 前回開いたフォルダの記憶（ADR-0005）。未指定なら記憶しない */
  readonly recent?: RecentFolderStore | null;
  /** 画像の取り込み時の最適化と表示用派生画像の生成（ADR-0005）。null なら原本をそのまま保存する */
  readonly processor?: ImageProcessor | null;
}

/** ブラウザ内の作業場所として開くときの情報（第38章） */
export interface OpenPlace {
  readonly displayName: string;
  readonly backupRoot: () => Promise<DirHandleLike>;
  readonly onDiskChange?: () => void;
}

export interface MediaState {
  readonly articleId: string;
  readonly files: MediaFile[];
  readonly exists: boolean;
  readonly error: string | null;
  /** 保存済み本文と cover からの参照（18.1） */
  readonly refs: MediaRefs | null;
}

export type ImportStatus = "pending" | "validating" | "saving" | "done" | "failed" | "cancelled";

export interface ImportJob {
  readonly fileName: string;
  status: ImportStatus;
  message: string;
  name: string | null;
  alt: string;
  inserted: boolean;
}

export interface ImportFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export class Workspace {
  root = $state<DirHandleLike | null>(null);
  rootName = $state("");
  articles = $state<DirHandleLike | null>(null);
  /** content/articles/ がないときの作成予定 */
  missingArticles = $state(false);
  folderError = $state<string | null>(null);
  config = $state<RepoConfig | null>(null);
  scan = $state<ScanResult | null>(null);
  scanning = $state(false);
  scanProgress = $state<{ done: number; total: number } | null>(null);
  #session = $state<EditorSession | null>(null);
  get session(): EditorSession | null {
    return this.#session;
  }
  set session(s: EditorSession | null) {
    if (this.#session && this.#session !== s) this.drafts?.cancel(this.#session);
    if (s) s.onChange = () => this.drafts?.onEdit(s);
    this.#session = s;
    this.media = null;
    this.importJobs = [];
  }
  media = $state<MediaState | null>(null);
  importJobs = $state<ImportJob[]>([]);
  /** 複製・削除・取り込み等の長い操作の工程表示（11.2） */
  operation = $state<string | null>(null);
  private importCancelled = false;
  dialog = $state<DialogRequest | null>(null);
  /** 支援技術へ通知する短い状態文（14.1） */
  announcement = $state("");
  opening = $state(false);
  /** 前回開いたフォルダ（名前だけを表示に使う） */
  recent = $state<{ name: string; at: number } | null>(null);
  private recentHandle: unknown = null;
  private readonly recentStore: RecentFolderStore | null;

  readonly queue = new SerialQueue();
  /** このセッションで作成した記事フォルダ（新規作成の再試行で所有を判断する） */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 画面に表示しない内部状態
  private readonly ownedDirs = new Set<string>();

  readonly drafts: DraftController | null;
  /** Git 機能（App が設定する） */
  git: GitHooks | null = null;
  /**
   * ブラウザ内の作業場所として開いたときの設定（仕様 3.2 第38章）。実フォルダでは null。
   * 退避先は利用者に選ばせず、作業場所の外の退避領域を使う（19.1 手順1）。
   */
  private place: OpenPlace | null = null;
  private readonly decoder: Decoder;
  private readonly processor: ImageProcessor | null;
  readonly md: MdService;
  private readonly appVersion: string;
  private readonly specVersion: string;

  constructor(
    private readonly host: PickerHost = globalThis as unknown as PickerHost,
    opts: WorkspaceOptions = {},
  ) {
    this.drafts = opts.drafts ?? null;
    this.decoder = opts.decoder ?? browserDecoder;
    this.md = opts.md ?? unavailableMdService;
    this.appVersion = opts.appVersion ?? "dev";
    this.specVersion = opts.specVersion ?? "dev";
    this.recentStore = opts.recent ?? null;
    this.processor = opts.processor === undefined ? browserProcessor : opts.processor;
  }

  get busy(): boolean {
    return this.scanning || this.opening || (this.session?.saving ?? false) || this.operation !== null;
  }

  ask(req: Omit<DialogRequest, "resolve">): Promise<string> {
    return new Promise((resolve) => {
      this.dialog = {
        ...req,
        resolve: (v) => {
          this.dialog = null;
          resolve(v);
        },
      };
    });
  }

  announce(text: string): void {
    this.announcement = "";
    queueMicrotask(() => (this.announcement = text));
  }

  // -------------------------------------------------------------------------
  // フォルダ選択（2.1・3.1）

  async chooseFolder(): Promise<void> {
    if (this.busy) return; // 操作中のフォルダ切り替えは無効（11.2）
    if (!(await this.confirmLeave("別のフォルダを開く前に、未保存の編集をどうしますか。"))) return;
    let handle: unknown;
    try {
      handle = await this.host.showDirectoryPicker?.({ mode: "readwrite" });
    } catch (e) {
      if (classifyFsError(e) === "aborted") return;
      this.folderError = `フォルダを開けません：${fsErrorMessage(classifyFsError(e))}`;
      return;
    }
    if (!handle) return;
    await this.openRoot(handle as DirHandleLike);
    if (this.root === handle) await this.rememberFolder(handle as DirHandleLike);
  }

  // -------------------------------------------------------------------------
  // 前回のフォルダ（ADR-0005）

  /**
   * 起動時に前回のフォルダを読み込む。権限が既に許可されていればそのまま開く。
   * 許可が必要な場合は、ユーザー操作（reopenRecent）まで待つ（requestPermission はユーザー操作が必要）。
   */
  async loadRecent(): Promise<void> {
    if (!this.recentStore || this.root) return;
    let r;
    try {
      r = await this.recentStore.load();
    } catch {
      return;
    }
    if (!r || this.root) return;
    this.recentHandle = r.handle;
    this.recent = { name: r.name, at: r.at };
    if (!looksLikeDirHandle(r.handle)) return;
    const h = r.handle as DirHandleLike;
    let state: string | undefined;
    try {
      state = await h.queryPermission?.({ mode: "readwrite" });
    } catch {
      state = undefined;
    }
    if (state === "granted" && !this.root && !this.busy) await this.openRoot(h);
  }

  /** 前回のフォルダを開き直す（権限を求める） */
  async reopenRecent(): Promise<void> {
    if (this.busy || !this.recent) return;
    if (!(await this.confirmLeave("別のフォルダを開く前に、未保存の編集をどうしますか。"))) return;
    const h = this.recentHandle;
    if (!looksLikeDirHandle(h)) {
      this.folderError = `前回のフォルダ「${this.recent.name}」を開けません。「フォルダを選択」から選び直してください。`;
      return;
    }
    const dir = h as DirHandleLike;
    let granted: boolean;
    try {
      const q = (await dir.queryPermission?.({ mode: "readwrite" })) ?? "granted";
      granted = q === "granted" || ((await dir.requestPermission?.({ mode: "readwrite" })) ?? "denied") === "granted";
    } catch {
      granted = false;
    }
    if (!granted) {
      this.folderError = `前回のフォルダ「${this.recent.name}」へのアクセスが許可されませんでした。`;
      return;
    }
    await this.openRoot(dir);
    if (this.root === dir) await this.rememberFolder(dir);
  }

  /** 記憶を消す（ファイルには触れない） */
  async forgetRecent(): Promise<void> {
    // 削除が終わってから表示を消す（消えた表示を見て再読み込みしても、記憶が残らないように）
    try {
      await this.recentStore?.clear();
    } catch {
      // 記憶の削除に失敗しても作業は続けられる
    }
    this.recent = null;
    this.recentHandle = null;
  }

  private async rememberFolder(handle: DirHandleLike): Promise<void> {
    if (!this.recentStore) return;
    try {
      await this.recentStore.save(handle, handle.name);
      this.recentHandle = handle;
      this.recent = { name: handle.name, at: Date.now() };
    } catch {
      // 構造化複製できないハンドル・ストレージ不可：記憶しないだけで、作業は続けられる
    }
  }

  async openRoot(root: DirHandleLike, place: OpenPlace | null = null): Promise<void> {
    this.session = null;
    this.place = place;
    this.root = root;
    this.rootName = place?.displayName ?? root.name;
    this.folderError = null;
    this.articles = null;
    this.missingArticles = false;
    this.scan = null;
    this.config = await readConfig(root);
    await this.drafts?.attach(root);
    const st = await openArticlesDir(root);
    if (st.kind === "ok") {
      this.articles = st.dir;
      await this.refreshList();
    } else if (st.kind === "missing") this.missingArticles = true;
    else this.folderError = st.message;
  }

  /** 確認後に content/articles/ を作成する（3.1） */
  async prepareArticles(): Promise<void> {
    const root = this.root;
    if (!root) return;
    const st = await this.queue.run(() => createArticlesDir(root));
    if (st.kind === "ok") {
      this.articles = st.dir;
      this.missingArticles = false;
      await this.refreshList();
    } else if (st.kind === "error") this.folderError = st.message;
  }

  // -------------------------------------------------------------------------
  // 一覧（23.2：現在記事の編集内容を保持したまま索引を更新する）

  async refreshList(): Promise<void> {
    const articles = this.articles;
    if (!articles || this.scanning) return;
    this.scanning = true;
    this.scanProgress = { done: 0, total: 0 };
    try {
      if (this.root) this.config = await readConfig(this.root);
      this.scan = await scanArticles(articles, (done, total) => (this.scanProgress = { done, total }));
      this.announce(
        `記事一覧を読み込みました（${this.scan.entries.filter((e) => e.kind !== "not-directory").length}件）。`,
      );
    } finally {
      this.scanning = false;
      this.scanProgress = null;
    }
  }

  private updateEntry(entry: ListEntry): void {
    if (!this.scan) return;
    const rest = this.scan.entries.filter((e) => e.dirName !== entry.dirName);
    this.scan = { ...this.scan, entries: [...rest, entry] };
  }

  // -------------------------------------------------------------------------
  // 未保存確認（13.1）

  /** 未保存の編集があれば、保存・破棄・キャンセルを選ばせる。続行してよければ true。 */
  async confirmLeave(message = "未保存の編集があります。どうしますか。"): Promise<boolean> {
    const s = this.session;
    if (!s || !s.dirty || s.readOnlyReason !== null) return true;
    const v = await this.ask({
      title: "未保存の編集",
      message,
      details: [
        "破棄すると、この記事の未保存の編集はメモリから消えます。保存済みのファイルは変わりません。",
        "破棄した編集は、ブラウザ内の復旧ドラフトからも削除します。",
      ],
      buttons: [
        { label: "保存する", value: "save", variant: "primary" },
        { label: "破棄する", value: "discard", variant: "danger" },
        { label: "キャンセル", value: "cancel" },
      ],
      initial: "cancel",
    });
    if (v === "save") {
      await this.save();
      return !this.session?.dirty;
    }
    if (v === "discard") await this.drafts?.discard(s);
    return v === "discard";
  }

  // -------------------------------------------------------------------------
  // 記事を開く

  async openArticle(id: string): Promise<void> {
    if (this.busy || !this.articles) return;
    if (this.session?.id === id && !this.session.isNew) return;
    if (!(await this.confirmLeave())) return;
    await this.loadArticle(id);
  }

  async loadArticle(id: string): Promise<void> {
    const articles = this.articles;
    if (!articles) return;
    this.opening = true;
    try {
      const r = await readArticle(articles, id);
      if (r.kind === "too-large") {
        this.session = readOnlySession(
          id,
          "",
          "記事ファイルが 5 MiB を超えているため、CMS では編集できません。外部エディタで編集してください。",
        );
        return;
      }
      if (r.kind === "error") {
        this.session = readOnlySession(id, "", `記事を読み込めません：${r.message}`);
        return;
      }
      const loaded = textFromBytes(r.bytes);
      if (!loaded.ok) {
        this.session = readOnlySession(id, "", loaded.reason);
        return;
      }
      const hash = await sha256Hex(r.bytes);
      const s = new EditorSession({
        id,
        text: loaded.text,
        base: { bytes: r.bytes, text: loaded.text, readAt: r.readAt, hash },
        isNew: false,
      });
      const ro = s.analysis.readOnlyReason ?? this.git?.readOnlyReason(id) ?? null;
      if (ro !== null) s.readOnlyReason = ro;
      this.session = s;
      this.announce(`記事 ${id} を開きました。`);
    } finally {
      this.opening = false;
    }
  }

  /** 現在の記事をディスクから読み直す（23.2：未保存確認後） */
  async reloadCurrent(): Promise<void> {
    const s = this.session;
    if (!s || s.isNew || this.busy) return;
    if (s.dirty) {
      const v = await this.ask({
        title: "ディスクから読み込み直す",
        message: "未保存の編集を破棄して、ディスク上の内容を読み込みます。",
        details: ["必要なら先に「原文をコピー」または「原文をダウンロード」で退避してください。"],
        buttons: [
          { label: "破棄して読み込む", value: "reload", variant: "danger" },
          { label: "キャンセル", value: "cancel" },
        ],
        initial: "cancel",
      });
      if (v !== "reload") return;
      await this.drafts?.discard(s);
    }
    await this.loadArticle(s.id);
  }

  // -------------------------------------------------------------------------
  // 新規作成（10.1）

  async createNew(): Promise<void> {
    if (this.busy || !this.articles || !this.root) return;
    if (!(await this.confirmLeave())) return;
    this.config = await readConfig(this.root);
    const blocked = canCreateArticles(this.config);
    if (blocked) {
      this.folderError = blocked;
      return;
    }
    const articles = this.articles;
    const alloc = await allocateArticleId(this.config.idLength, (id) => entryExists(articles, id));
    if (!alloc.ok) {
      this.folderError =
        alloc.reason === "exhausted"
          ? "記事IDの候補がすべて既存のエントリーと重なりました。設定とディレクトリを確認してください。"
          : "記事IDの重複を確認できません。フォルダへのアクセスを確認してください。";
      return;
    }
    const createdAt = nowDateTime();
    this.session = new EditorSession({
      id: alloc.id,
      text: newArticleText(alloc.id, createdAt),
      base: null,
      isNew: true,
      newCreatedAt: createdAt,
    });
    this.announce("新規記事を作成しました（未保存）。");
  }

  // -------------------------------------------------------------------------
  // 保存（13）

  async save(): Promise<void> {
    const s = this.session;
    const root = this.root;
    const articles = this.articles;
    if (!s || !root || !articles || s.saving) return; // 二重実行を防ぐ（F07）
    if (s.readOnlyReason !== null) {
      s.notice = { kind: "error", text: s.readOnlyReason };
      return;
    }
    if (s.locked !== null) {
      s.notice = { kind: "error", text: s.locked };
      return;
    }
    if (s.recoveryMismatch) {
      const v = await this.ask({
        title: "復旧ドラフトを保存します",
        message:
          "このドラフトは、作成時の基準版と現在のディスクの内容が異なります。保存すると、ディスク上の内容をこの編集内容で置き換えます。",
        details: [
          "基準版の本文は保存していないため、3版の比較はできません。先に原文を退避し、ディスク版と見比べてください。",
        ],
        buttons: [
          { label: "置き換えて保存", value: "ok", variant: "danger" },
          { label: "キャンセル", value: "cancel" },
        ],
        initial: "cancel",
      });
      if (v !== "ok") return;
      s.recoveryMismatch = false;
    }
    // 1. スナップショットとリビジョンを固定する
    let snapshot = s.text;
    const snapRevision = s.revision;
    const draftKey = DraftController.keyOf(s);
    const savedBefore = s.lastSavedAt;
    // 保存したリビジョンと後続の編集を別の Undo 単位にする
    s.sealHistory();
    const pre = s.precheck(snapshot);
    if (!pre.ok) {
      s.notice = pre.notice;
      this.announce(pre.notice.text);
      return;
    }
    s.saving = true;
    s.notice = { kind: "info", text: "保存中…" };
    try {
      // 新規作成：最新設定と ID 重複を再確認し、既存なら再生成する（10.1）
      if (s.isNew) {
        this.config = await readConfig(root);
        const blocked = canCreateArticles(this.config);
        if (blocked) {
          s.notice = { kind: "error", text: blocked };
          return;
        }
        if (!this.ownedDirs.has(s.id) && (await entryExists(articles, s.id).catch(() => true))) {
          const alloc = await allocateArticleId(
            this.config.idLength,
            (id) => entryExists(articles, id),
            generateArticleId,
          );
          if (!alloc.ok) {
            s.notice = { kind: "error", text: "記事IDを確保できません。ディレクトリを確認してください。" };
            return;
          }
          s.changeNewId(alloc.id);
          snapshot = s.text;
          s.notice = { kind: "warn", text: `記事IDが既存のエントリーと重なったため、${alloc.id} に変更しました。` };
        }
      }

      // 2. 全体検証：slug の一意性（7.1）
      const values = s.analysis.schema?.values ?? {};
      const slug = values.slug ?? "";
      if (slug !== "" && (pre.slugChanged || pre.becamePublished || s.isNew)) {
        // 一覧キャッシュだけに頼らず記事領域を再走査する
        const fresh = await scanArticles(articles);
        this.scan = fresh;
        const u = checkSlugUniqueness(slug, s.id, slugEntries(fresh));
        if (u.kind === "duplicate") {
          s.notice = { kind: "error", text: `slug「${slug}」は他の記事（${u.ids.join("、")}）と重複しています。` };
          return;
        }
        if (u.kind === "uncheckable") {
          s.notice = {
            kind: "error",
            text: `重複検査不能：${u.ids.length}件の記事の slug を確認できないため保存を止めました。`,
            details: u.ids.map((id) => `検査不能：${id}`),
          };
          return;
        }
      } else if (slug !== "" && this.scan) {
        // 当該記事の既知の重複は修正が必要（7.1）
        const known = checkSlugUniqueness(
          slug,
          s.id,
          slugEntries(this.scan).filter((e) => e.slug !== null),
        );
        if (known.kind === "duplicate") {
          s.notice = { kind: "error", text: `slug「${slug}」は他の記事（${known.ids.join("、")}）と重複しています。` };
          return;
        }
      }
      if (pre.slugChangedAfterPublish) {
        const v = await this.ask({
          title: "公開対象の記事の slug を変更します",
          message:
            "slug を変えると、サイト側の URL が変わる可能性があります。リダイレクトはサイト側で用意してください。",
          buttons: [
            { label: "変更して保存", value: "ok", variant: "primary" },
            { label: "キャンセル", value: "cancel" },
          ],
          initial: "cancel",
        });
        if (v !== "ok") {
          s.notice = { kind: "info", text: "保存を取り消しました。" };
          return;
        }
      }

      const snap = snapshot;
      const build = () => s.buildCandidate(snap, pre.bump);
      await this.queue.run(async () => {
        if (s.isNew) await this.saveNew(s, root, articles, build);
        else await this.saveCurrent(s, root, articles, build);
      });
      if (s.lastSavedAt !== savedBefore) await this.drafts?.saved(s, snapRevision, draftKey).catch(() => undefined);
    } catch (e) {
      s.resultUnknown = true;
      s.notice = { kind: "error", text: `保存の結果が不明です：${e instanceof Error ? e.message : String(e)}` };
    } finally {
      s.saving = false;
      if (s.notice) this.announce(s.notice.text);
    }
  }

  private async saveCurrent(
    s: EditorSession,
    root: DirHandleLike,
    articles: DirHandleLike,
    build: BuildCandidate,
  ): Promise<void> {
    if (!s.base) return;
    const r = await saveExisting({
      root,
      articles,
      id: s.id,
      baseBytes: s.base.bytes,
      previousCandidate: s.pendingCandidate,
      buildCandidate: build,
    });
    switch (r.kind) {
      case "saved":
        await s.adoptSaved(r.bytes);
        s.notice = {
          kind: "ok",
          text: r.adoptedPrevious ? "前回の保存候補がディスクに保存済みであることを確認しました。" : "保存しました。",
        };
        await this.refreshEntry(s.id);
        return;
      case "external-change":
        await s.setConflict(r.disk, Date.now());
        s.notice = {
          kind: "error",
          text: EXTERNAL_CHANGE_NOTICE,
        };
        return;
      case "candidate-invalid":
        s.notice = problemsNotice("保存候補が再読込の条件を満たさないため、書き込みませんでした。", r.problems);
        return;
      case "permission-denied":
        s.notice = {
          kind: "error",
          text: "権限不足：フォルダへの書き込みが許可されていません。編集内容は保持しています。許可し直してから保存するか、原文を退避してください。",
        };
        return;
      case "write-failed":
      case "unknown":
        this.applyFailure(s, r.kind, r.message, r.disk, r.bytes);
        return;
    }
  }

  private async saveNew(
    s: EditorSession,
    root: DirHandleLike,
    articles: DirHandleLike,
    build: BuildCandidate,
  ): Promise<void> {
    const r = await createArticle({
      root,
      articles,
      id: s.id,
      ownedDirs: this.ownedDirs,
      previousCandidate: s.pendingCandidate,
      buildCandidate: build,
    });
    switch (r.kind) {
      case "created":
        await s.adoptSaved(r.bytes);
        s.notice = { kind: "ok", text: `記事を作成しました（${ARTICLES_PATH}${s.id}/index.md）。` };
        await this.refreshEntry(s.id);
        return;
      case "exists":
        s.notice = {
          kind: "error",
          text: "作成先に同名のエントリーが現れたため、書き込まずに止めました。もう一度保存すると新しい記事IDで作成します。",
        };
        return;
      case "not-owned":
        s.notice = { kind: "error", text: r.message };
        return;
      case "candidate-invalid":
        s.notice = problemsNotice("保存候補が再読込の条件を満たさないため、書き込みませんでした。", r.problems);
        return;
      case "permission-denied":
        s.notice = {
          kind: "error",
          text: "権限不足：フォルダへの書き込みが許可されていません。編集内容は保持しています。",
        };
        return;
      case "incomplete":
        s.pendingCandidate = r.bytes;
        s.resultUnknown = true;
        s.notice = {
          kind: "error",
          text: `作成は完了していません（不完全）：${r.message}`,
          details: [
            `残存している可能性のあるパス：${r.path}`,
            "もう一度保存すると、ディスクの状態を確認してから再試行します。",
          ],
        };
        await this.refreshEntry(s.id);
        return;
    }
  }

  private applyFailure(
    s: EditorSession,
    kind: "write-failed" | "unknown",
    message: string,
    disk: DiskClass,
    bytes: Uint8Array,
  ): void {
    s.pendingCandidate = bytes;
    const where: Record<DiskClass, string> = {
      base: "ディスクは読み込み時の内容のままです。",
      candidate: "ディスクは保存候補と一致しています。",
      third: "ディスクは読み込み時とも保存候補とも異なる内容です（外部変更の可能性）。",
      missing: "ファイルが見つかりません。",
      unreadable: "ディスクの内容を確認できません。",
    };
    s.resultUnknown = disk !== "base";
    s.notice = {
      kind: "error",
      text: kind === "write-failed" ? `保存に失敗しました：${message}` : `結果不明：${message}`,
      details: [
        where[disk],
        "編集内容は保持しています。再試行するとディスクを読み直して状態を照合します。原文を退避することもできます。",
      ],
    };
  }

  // -------------------------------------------------------------------------
  // 専用の修復操作（10.3・24.1）：差分を示し、確認後に編集として適用する（保存は通常の手動保存）

  async repairId(): Promise<void> {
    const s = this.session;
    if (!s || s.isNew || !s.editable) return;
    const p = proposeIdFix(s.text, s.id);
    await this.applyRepair(s, p, "id をフォルダ名に合わせます", [
      "フォルダ名（記事ID）を正として、frontmatter の id だけを書き換えます。フォルダ名・画像・他の項目は変更しません。",
      "別の記事が同じフォルダへ合流した疑いがある場合は、この操作ではなく外部ツールで一方に新しい ID を割り当ててください（10.3）。",
    ]);
  }

  async repairCreatedAt(source: "updatedAt" | "now"): Promise<void> {
    const s = this.session;
    if (!s || s.isNew || !s.editable) return;
    const updated = s.analysis.schema?.values.updatedAt;
    const value = source === "updatedAt" && updated && isValidDateTime(updated) ? updated : nowDateTime();
    const p = proposeCreatedAtFix(s.text, s.id, value);
    await this.applyRepair(s, p, "createdAt を設定します", [
      source === "updatedAt"
        ? "updatedAt と同じ値を作成日時として使います。実際の作成日時とは異なる可能性があります。"
        : "現在時刻を作成日時として使います。実際の作成日時とは異なります。",
      "値は自動では補いません。この確認の後も、保存するまでディスクは変わりません。",
    ]);
  }

  private async applyRepair(
    s: EditorSession,
    p: RepairProposal | { error: string },
    title: string,
    notes: string[],
  ): Promise<void> {
    if ("error" in p) {
      s.notice = { kind: "error", text: p.error };
      return;
    }
    const v = await this.ask({
      title,
      message: "次の差分を編集内容に適用します。",
      details: [`変更前：${p.before ?? "（項目なし）"}`, `変更後：${p.after}`, ...notes],
      buttons: [
        { label: "適用する", value: "apply", variant: "primary" },
        { label: "キャンセル", value: "cancel" },
      ],
      initial: "cancel",
    });
    if (v !== "apply" || this.session !== s || !s.editable) return;
    s.setText(p.text, null);
    s.notice = { kind: "info", text: "修正を編集内容に適用しました。保存すると記事ファイルに反映されます。" };
  }

  /** 削除確認に添える Git 状態（19）。Git 機能が判定できなければ「未確認」と明示する */
  private async gitDetails(id: string, relPaths?: readonly string[]): Promise<string[]> {
    const fallback = ["Git 状態：未確認。Git だけで未コミットの内容を復元できるとは限りません。"];
    if (!this.git) return fallback;
    try {
      const d = await this.git.describe(id, relPaths);
      return d.length > 0 ? d : fallback;
    } catch {
      return fallback;
    }
  }

  private async refreshEntry(id: string): Promise<void> {
    this.git?.changed(id);
    this.noteDiskChange();
    const articles = this.articles;
    if (!articles) return;
    try {
      const dir = await articles.getDirectoryHandle(id);
      this.updateEntry(await readEntryMeta(dir));
    } catch {
      // 一覧の更新に失敗しても保存結果は変わらない。再読み込みで反映する。
    }
  }

  /** 外部変更時：ディスク版を読み込む（編集を破棄） */
  async takeDisk(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const v = await this.ask({
      title: "ディスク版を読み込む",
      message: "編集中の内容を破棄して、現在のディスク上の内容を読み込みます。",
      details: ["編集中の原文は先にコピーまたはダウンロードで退避できます。"],
      buttons: [
        { label: "破棄して読み込む", value: "ok", variant: "danger" },
        { label: "キャンセル", value: "cancel" },
      ],
      initial: "cancel",
    });
    if (v === "ok") {
      await this.drafts?.discard(s);
      await this.loadArticle(s.id);
    }
  }

  /** 外部変更の比較を最新のディスク状態で取り直す */
  async recheckDisk(): Promise<void> {
    const s = this.session;
    const articles = this.articles;
    if (!s || !articles) return;
    const { state } = await readDiskArticle(articles, s.id);
    await s.setConflict(state, Date.now());
  }

  /** 編集中の記事を閉じる（未保存確認あり） */
  async closeArticle(): Promise<void> {
    if (this.busy) return;
    if (!(await this.confirmLeave())) return;
    this.session = null;
  }

  // -------------------------------------------------------------------------
  // 未保存の編集があるときの前処理（10.2・18.2・19：保存または破棄を先に選ばせる）

  private async requireSaved(s: EditorSession, what: string): Promise<EditorSession | null> {
    if (!s.dirty) return s;
    const v = await this.ask({
      title: "未保存の編集があります",
      message: `${what}の前に、未保存の編集を保存するか破棄してください。`,
      buttons: [
        { label: "保存する", value: "save", variant: "primary" },
        { label: "破棄する", value: "discard", variant: "danger" },
        { label: "キャンセル", value: "cancel" },
      ],
      initial: "cancel",
    });
    if (v === "save") {
      await this.save();
      return this.session === s && !s.dirty ? s : null;
    }
    if (v === "discard") {
      await this.drafts?.discard(s);
      await this.loadArticle(s.id);
      const n = this.session;
      return n && !n.dirty && n.readOnlyReason === null ? n : null;
    }
    return null;
  }

  private fail(s: EditorSession, text: string, details?: readonly string[]): void {
    s.notice = details ? { kind: "error", text, details } : { kind: "error", text };
    this.announce(text);
  }

  /** 作業場所として開いているか（第38章） */
  get isPlace(): boolean {
    return this.place !== null;
  }

  /** ディスク上の記事が変わった（保存・複製・削除・画像の取り込み・コミット）。作業場所の「端末の外にない変更」に使う */
  noteDiskChange(): void {
    this.place?.onDiskChange?.();
  }

  /** 作業場所を閉じる（ロック・削除の前：第39.3節） */
  close(): void {
    this.session = null;
    this.place = null;
    this.root = null;
    this.rootName = "";
    this.articles = null;
    this.missingArticles = false;
    this.scan = null;
    this.config = null;
  }

  private async pickBackupRoot(): Promise<DirHandleLike | null> {
    if (this.place) {
      try {
        return await this.place.backupRoot();
      } catch {
        return null;
      }
    }
    try {
      const h = await this.host.showDirectoryPicker?.({ mode: "readwrite", id: "kotono-backup" });
      return (h as DirHandleLike | undefined) ?? null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 画像（17・18）

  async refreshMedia(): Promise<void> {
    const s = this.session;
    const articles = this.articles;
    if (!s || s.isNew || !articles) {
      this.media = null;
      return;
    }
    const id = s.id;
    let refs: MediaRefs | null = null;
    if (s.base) {
      refs = await this.refsOf(s.base.text, id);
    }
    try {
      const dir = await articles.getDirectoryHandle(id);
      const r = await listMedia(dir);
      this.git?.changed(id);
      this.noteDiskChange();
      if (this.session?.id !== id) return;
      this.media = r.ok
        ? { articleId: id, files: r.files, exists: r.exists, error: null, refs }
        : { articleId: id, files: [], exists: false, error: r.message, refs };
    } catch (e) {
      this.media = { articleId: id, files: [], exists: false, error: fsErrorMessage(classifyFsError(e)), refs };
    }
  }

  /** 保存済み文書の本文と cover からの参照（18.1） */
  private async refsOf(text: string, id: string): Promise<MediaRefs> {
    const a = analyzeText(text, id);
    const cover = a.schema?.values.cover?.src ?? null;
    if (!a.split.ok) return refsFromTree(null, cover, "文書を解析できません。");
    return this.md.refs(a.split.body, cover);
  }

  cancelImport(): void {
    this.importCancelled = true;
  }

  /** 画像の取り込み（17・17.1・17.2）：1ファイルずつ検証・保存し、成功分だけを挿入候補にする */
  async importImages(files: readonly ImportFile[]): Promise<void> {
    const s = this.session;
    const root = this.root;
    const articles = this.articles;
    if (!s || !root || !articles || this.operation !== null) return;
    if (s.isNew) return this.fail(s, "画像を取り込む前に、記事を一度保存してください（10.1）。");
    if (!s.editable) return this.fail(s, s.locked ?? s.readOnlyReason ?? "編集できません。");
    this.config = await readConfig(root);
    const blocked = canImportMedia(this.config);
    if (blocked) return this.fail(s, blocked);
    const limits = effectiveLimits(this.config.media);
    if (files.length > limits.maxBatch)
      return this.fail(
        s,
        `一度に取り込めるのは ${limits.maxBatch} ファイルまでです（${files.length} ファイルを選択）。`,
      );
    const id = s.id;
    const jobs: ImportJob[] = files.map((f) => ({
      fileName: f.name,
      status: "pending",
      message: "未処理",
      name: null,
      alt: "",
      inserted: false,
    }));
    this.importJobs = jobs;
    const live = () => this.importJobs;
    const update = (i: number, patch: Partial<ImportJob>) => {
      const cur = live()[i];
      if (cur) Object.assign(cur, patch);
    };
    this.importCancelled = false;
    this.operation = "画像の取り込み";
    try {
      for (let i = 0; i < files.length; i++) {
        if (this.importCancelled) {
          for (let j = i; j < files.length; j++) update(j, { status: "cancelled", message: "キャンセルしました" });
          break;
        }
        const f = files[i] as ImportFile;
        update(i, { status: "validating", message: "検証中" });
        const v = await validateImport(f, limits, this.decoder, IMAGE_TASK_MAX_MS);
        if (!v.ok) {
          update(i, { status: "failed", message: v.message });
          continue;
        }
        // 取り込み時の最適化と表示用の派生画像（ADR-0005）
        let original: { bytes: Uint8Array; info: ImageInfo } = { bytes: v.bytes, info: v.info };
        let variants: EncodedVariant[] = [];
        let notes: string[] = [];
        if (this.processor) {
          update(i, { status: "validating", message: "最適化中" });
          let p: ProcessResult;
          try {
            p = await withTimeout(
              this.processor.process(v.bytes, v.info),
              IMAGE_TASK_MAX_MS,
              "画像の最適化が時間上限を超えました。",
            );
          } catch (e) {
            p = { ok: false, message: e instanceof Error ? e.message : String(e) };
          }
          if (!p.ok) {
            update(i, { status: "failed", message: p.message });
            continue;
          }
          original = p.original;
          variants = p.variants;
          notes = p.notes;
        }
        update(i, { status: "saving", message: "保存中" });
        const r = await this.queue.run(async () => {
          if (!(await ensureWritePermission(root)))
            return { ok: false as const, message: "書き込みが許可されていません。", leftover: null };
          const dir = await articles.getDirectoryHandle(id);
          const saved = await saveMedia(dir, original.info, original.bytes);
          if (!saved.ok) return saved;
          const vs = await saveVariants(dir, saved.name, variants);
          return { ...saved, variants: vs };
        });
        if (r.ok) {
          const extra = [
            ...notes,
            ...(r.variants.saved.length > 0 ? [`表示用の派生画像 ${r.variants.saved.length} 件`] : []),
            ...(r.variants.failed
              ? [`派生画像の一部を保存できません（表示は原本を使います）：${r.variants.failed}`]
              : []),
          ];
          update(i, {
            status: "done",
            message: `保存しました（media/${r.name}）${extra.length > 0 ? `：${extra.join("、")}` : ""}`,
            name: r.name,
          });
        } else
          update(i, {
            status: "failed",
            message: r.leftover ? `${r.message}（残存の可能性：${r.leftover}）` : r.message,
          });
      }
    } catch (e) {
      s.notice = { kind: "error", text: `画像の取り込みを中断しました：${e instanceof Error ? e.message : String(e)}` };
    } finally {
      this.operation = null;
    }
    const ok = live().filter((j) => j.status === "done").length;
    const ng = live().filter((j) => j.status === "failed").length;
    s.notice = {
      kind: ng > 0 ? "warn" : "ok",
      text: `画像を ${ok} 件取り込みました${ng > 0 ? `（失敗 ${ng} 件）` : ""}。alt を確認してから本文へ挿入してください。`,
    };
    this.announce(s.notice.text);
    await this.refreshMedia();
  }

  /** 成功した画像だけを本文へ挿入する（17.1） */
  insertImage(name: string, alt: string): void {
    const s = this.session;
    if (!s) return;
    const r = s.insertIntoBody(imageMarkdown(alt, name));
    if (!r.ok) return this.fail(s, r.message);
    const job = this.importJobs.find((j) => j.name === name);
    if (job) job.inserted = true;
    this.announce(`画像 ${name} を本文へ挿入しました。`);
  }

  setCover(name: string, alt: string): void {
    const s = this.session;
    if (!s) return;
    const r = s.setField("cover", { src: `./${MEDIA_DIR}/${name}`, alt });
    if (!r.ok) return this.fail(s, r.message);
    this.announce(`カバー画像を ${name} にしました（未保存）。`);
  }

  /** 画像の削除（18.2・19.1・11.3） */
  async deleteMedia(name: string): Promise<void> {
    const first = this.session;
    const root = this.root;
    const articles = this.articles;
    if (!first || first.isNew || !root || !articles || this.busy) return;
    if (!first.editable) return this.fail(first, first.locked ?? first.readOnlyReason ?? "編集できません。");
    const s = await this.requireSaved(first, "画像の削除");
    if (!s || !s.base) return;
    const id = s.id;
    const path = `${ARTICLES_PATH}${id}/${MEDIA_DIR}/${name}`;
    const refsOf = (text: string) => this.refsOf(text, id);
    const refs = await refsOf(s.base.text);
    if (refs.status === "unknown")
      return this.fail(
        s,
        "参照状況不明：この画像が使われていないと判定できないため、CMS からは削除できません。外部ツールで確認してください。",
        refs.reasons,
      );
    if (refs.names.has(name))
      return this.fail(
        s,
        `この画像は保存済みの本文または cover から参照されています。先に参照を外して保存してください（${name}）。`,
      );

    this.operation = "画像の削除";
    try {
      const articleDir = await articles.getDirectoryHandle(id);
      const mediaDir = await articleDir.getDirectoryHandle(MEDIA_DIR);
      const handle = await mediaDir.getFileHandle(name);
      const bytes = await readAllBytes(handle, Number.MAX_SAFE_INTEGER);
      if (!bytes.ok) return this.fail(s, `画像を読み取れません：${bytes.message}`);
      // 表示用の派生画像も一緒に退避・削除する（ADR-0005）
      const variantItems: BackupItem[] = [];
      const vrefs = (await listVariants(articleDir)).get(mediaIdOf(name)) ?? [];
      if (vrefs.length > 0) {
        const vdir = await mediaDir.getDirectoryHandle(VARIANTS_DIR);
        for (const v of vrefs)
          variantItems.push({
            path: `${MEDIA_DIR}/${VARIANTS_DIR}/${v.name}`,
            kind: "file",
            handle: await vdir.getFileHandle(v.name),
          });
      }
      const confirmedRevision = s.revision;
      const v = await this.ask({
        title: "画像を削除します",
        message: `${path}（${bytes.bytes.length.toLocaleString()} バイト）を削除します。削除の前に、リポジトリ外の退避先フォルダへコピーし、検証します。`,
        details: [
          "参照の確認範囲：この記事の保存済み本文と cover だけです。別の記事や独自の frontmatter 項目からの参照は確認していません。",
          ...(variantItems.length > 0
            ? [`表示用の派生画像 ${variantItems.length} 件（media/${VARIANTS_DIR}/）も一緒に退避・削除します。`]
            : []),
          ...(await this.gitDetails(id, [`${MEDIA_DIR}/${name}`, ...variantItems.map((v) => v.path)])),
          "復元は CMS では行いません。退避先から外部ツールで戻してください。",
        ],
        buttons: [
          { label: "退避先を選んで退避する", value: "backup", variant: "primary" },
          { label: "キャンセル", value: "cancel" },
        ],
        initial: "cancel",
      });
      if (v !== "backup") return;
      const backupRoot = await this.pickBackupRoot();
      if (!backupRoot) return this.fail(s, "退避先が選ばれなかったため、削除しませんでした。");
      const item: BackupItem = { path: `${MEDIA_DIR}/${name}`, kind: "file", handle };
      this.operation = "画像の削除：退避中";
      const b = await this.queue.run(() =>
        createBackup({
          backupRoot,
          repoRoot: root,
          operation: "delete-media",
          articleId: id,
          items: [item, ...variantItems],
          appVersion: this.appVersion,
          specVersion: this.specVersion,
        }),
      );
      if (!b.ok)
        return this.fail(
          s,
          `退避できなかったため、削除しませんでした：${b.message}`,
          b.folderName
            ? [`途中まで作成した退避フォルダ：${backupRoot.name}/${b.folderName}（自動では削除しません）`]
            : undefined,
        );
      const where = `${backupRoot.name}/${b.folderName}`;
      if (s.revision !== confirmedRevision || s.dirty)
        return this.fail(
          s,
          "確認の後に記事が編集されたため、削除を中止しました。保存または破棄してから、もう一度確認してください。",
          [`退避は保持しています：${where}`],
        );
      const v2 = await this.ask({
        title: "退避を検証しました",
        message: `退避先：${where}（${b.totalBytes.toLocaleString()} バイト、検証 ${b.verifiedAt}）。${name} を削除しますか。`,
        details: ["削除したファイルは CMS からは戻せません。"],
        buttons: [
          { label: "画像を削除する", value: "delete", variant: "danger" },
          { label: "キャンセル", value: "cancel" },
        ],
        initial: "cancel",
      });
      if (v2 !== "delete") {
        s.notice = { kind: "info", text: `削除を取り消しました。退避は保持しています：${where}` };
        return;
      }
      // 個別削除の確定工程：対象記事の編集を止めてから最終照合し、削除 API の結果照合まで再開しない（11.3）
      this.operation = "画像の削除：削除中（取り消せません）";
      s.locked = "画像の削除中のため、この記事は一時的に編集できません。";
      try {
        const res = await this.queue.run(async () => {
          if (s.dirty || s.revision !== confirmedRevision || !s.base) return "確認の後に記事が編集されました。";
          const disk = await readDiskArticle(articles, id);
          if (disk.state.kind !== "bytes" || !bytesEqual(disk.state.bytes, s.base.bytes))
            return "保存済みの記事ファイルがディスク上で変わっています。";
          const now = await refsOf(s.base.text);
          if (now.status !== "ok" || now.names.has(name)) return "最新の保存済み本文で参照を確認できません。";
          const cur = await readAllBytes(handle, Number.MAX_SAFE_INTEGER);
          const want = b.manifest.entries.find((e) => e.path === item.path)?.sha256;
          if (!cur.ok || (await sha256Hex(cur.bytes)) !== want) return "確認の後に画像の内容が変わりました。";
          const extra: Fingerprint[] = b.manifest.entries.filter((e) => variantItems.some((v) => v.path === e.path));
          const rep = await deleteEntries(
            articleDir,
            [{ path: item.path, kind: "file", size: cur.bytes.length, sha256: want ?? null }, ...extra],
            null,
          );
          return rep.error;
        });
        if (res)
          return this.fail(s, `画像を削除しませんでした（または完了を確認できません）：${res}`, [
            `退避は保持しています：${where}`,
          ]);
      } finally {
        s.locked = null;
      }
      s.notice = { kind: "ok", text: `画像を削除しました（${path}）。退避先：${where}` };
      this.announce(s.notice.text);
    } catch (e) {
      this.fail(s, `画像を削除できません：${fsErrorMessage(classifyFsError(e))}`);
    } finally {
      this.operation = null;
      await this.refreshMedia();
    }
  }

  // -------------------------------------------------------------------------
  // 複製（10.2）

  async duplicateCurrent(): Promise<void> {
    const first = this.session;
    const root = this.root;
    const articles = this.articles;
    if (!first || first.isNew || !root || !articles || this.busy) return;
    if (first.readOnlyReason !== null) return this.fail(first, "読み取り専用の記事は複製できません。");
    const s = await this.requireSaved(first, "複製");
    if (!s || !s.base) return;
    if (s.analysis.problems.length > 0) return this.fail(s, "検証エラーのある記事は複製できません。");
    this.config = await readConfig(root);
    const blocked = canCreateArticles(this.config);
    if (blocked) return this.fail(s, blocked.replace("新規作成", "複製"));
    const id = s.id;
    this.operation = "記事の複製：確認中";
    try {
      const disk = await readDiskArticle(articles, id);
      if (disk.state.kind !== "bytes" || !bytesEqual(disk.state.bytes, s.base.bytes))
        return this.fail(s, "複製元が読み込み後に変わっています。再読み込みしてから複製してください。");
      const dir = await articles.getDirectoryHandle(id);
      const tree = await enumerateTree(dir);
      if (!tree.ok) return this.fail(s, `複製できません：${tree.message}`);
      const fp = await fingerprint(tree.entries);
      if (!fp.ok) return this.fail(s, `複製できません：${fp.message}`);
      const unknown = unknownKeys(s.analysis);
      const v = await this.ask({
        title: "記事を複製します",
        message: `${tree.files} ファイル・${tree.dirs} フォルダ（合計 ${tree.totalBytes.toLocaleString()} バイト）を新しい記事フォルダへコピーします。`,
        details: [
          "新しい記事は下書き（draft）、slug は空、publishedAt は null、作成・更新日時は複製の確定時刻になります。",
          unknown.length > 0
            ? `未知の項目（${unknown.join("、")}）は値を変えずにコピーします。中の ID・外部参照・固有値は自動では変換しません。`
            : "未知の項目はありません。",
          ...tree.entries.map(
            (e) =>
              `${e.kind === "dir" ? "フォルダ" : "ファイル"}：${e.path}${e.kind === "file" ? `（${e.size.toLocaleString()} バイト）` : ""}`,
          ),
        ],
        buttons: [
          { label: "複製する", value: "ok", variant: "primary" },
          { label: "キャンセル", value: "cancel" },
        ],
        initial: "ok",
      });
      if (v !== "ok") return;
      const alloc = await allocateArticleId(this.config.idLength, (x) => entryExists(articles, x));
      if (!alloc.ok) return this.fail(s, "新しい記事IDを確保できません。");
      const newId = alloc.id;
      const sourceText = s.base.text;
      this.operation = "記事の複製：コピー中";
      const r = await this.queue.run(async () => {
        if (!(await ensureWritePermission(root))) return { kind: "permission" as const };
        return duplicateArticle({
          articles,
          sourceId: id,
          newId,
          planned: fp.items,
          sourceEntries: tree.entries,
          ownedDirs: this.ownedDirs,
          buildIndex: () => {
            const t = duplicateText(sourceText, newId, nowDateTime());
            if (!t.ok) return { ok: false, problems: [{ message: t.message }] };
            const bytes = encodeUtf8(t.text);
            const c = verifyCandidateBytes(bytes, newId);
            return c.ok ? { ok: true, bytes } : { ok: false, problems: c.problems };
          },
        });
      });
      switch (r.kind) {
        case "permission":
          return this.fail(s, "権限不足：フォルダへの書き込みが許可されていません。");
        case "exists":
          return this.fail(s, "作成先に同名のエントリーが現れたため、複製を止めました。もう一度試してください。");
        case "source-changed":
          await this.refreshEntry(newId);
          return this.fail(s, `複製元が変わったため、複製を止めました：${r.message}`, [
            `作成途中のフォルダ：${ARTICLES_PATH}${newId}/（完成記事ではありません。自動では削除しません）`,
          ]);
        case "candidate-invalid":
          await this.refreshEntry(newId);
          return this.fail(
            s,
            "複製後の index.md が検証を通らないため、作成を止めました。",
            r.problems.map((p) => p.message),
          );
        case "incomplete":
          await this.refreshEntry(newId);
          return this.fail(
            s,
            `複製は完了していません（不完全）：${r.message}`,
            r.path ? [`残存しているパス：${r.path}（自動では再利用・削除しません）`] : undefined,
          );
        case "done":
          break;
      }
      await this.refreshEntry(newId);
      this.operation = null;
      await this.loadArticle(newId);
      const n = this.session;
      if (n)
        n.notice = { kind: "ok", text: `記事 ${id} を複製し、${newId} を作成しました（${r.files + 1} ファイル）。` };
      this.announce(`記事 ${id} を複製し、${newId} を作成しました。`);
    } catch (e) {
      this.fail(s, `複製できません：${fsErrorMessage(classifyFsError(e))}`);
    } finally {
      this.operation = null;
    }
  }

  // -------------------------------------------------------------------------
  // 記事の削除（19・19.1・11.3）

  async deleteCurrent(): Promise<void> {
    const first = this.session;
    const root = this.root;
    const articles = this.articles;
    if (!first || first.isNew || !root || !articles || this.busy) return;
    const s = first.readOnlyReason !== null ? first : await this.requireSaved(first, "記事の削除");
    if (!s) return;
    const id = s.id;
    const title = s.analysis.schema?.values.title ?? "";
    // 最初の確認画面を開く時点から、結果判定まで対象記事の編集を止める（11.3）
    s.locked = "記事の削除手続き中のため、この記事は編集できません（コピー・退避は可能です）。";
    this.operation = "記事の削除：対象の確認中";
    let finished = false;
    try {
      const dir = await articles.getDirectoryHandle(id);
      const tree = await enumerateTree(dir);
      if (!tree.ok) return this.fail(s, `対象をすべて列挙できないため、削除できません：${tree.message}`);
      const v = await this.ask({
        title: "記事を削除します",
        message: `「${title || "無題"}」（${id}）の記事フォルダ全体（${tree.files} ファイル・${tree.dirs} フォルダ、合計 ${tree.totalBytes.toLocaleString()} バイト）を削除します。削除の前に、リポジトリ外の退避先フォルダへコピーし、検証します。`,
        details: [
          "未知のファイル・隠しファイル・サブフォルダを含め、次のすべてが対象です。",
          ...tree.entries.map(
            (e) =>
              `${e.kind === "dir" ? "フォルダ" : "ファイル"}：${ARTICLES_PATH}${id}/${e.path}${e.kind === "file" ? `（${e.size.toLocaleString()} バイト）` : ""}`,
          ),
          ...(await this.gitDetails(id)),
          "CMS 独自のゴミ箱はありません。復元は退避先から外部ツールで行います。",
        ],
        buttons: [
          { label: "退避先を選んで退避する", value: "backup", variant: "primary" },
          { label: "キャンセル", value: "cancel" },
        ],
        initial: "cancel",
      });
      if (v !== "backup") return;
      const backupRoot = await this.pickBackupRoot();
      if (!backupRoot) return this.fail(s, "退避先が選ばれなかったため、削除しませんでした。");
      this.operation = "記事の削除：退避中";
      const b = await this.queue.run(() =>
        createBackup({
          backupRoot,
          repoRoot: root,
          operation: "delete-article",
          articleId: id,
          items: itemsFromTree(tree.entries),
          appVersion: this.appVersion,
          specVersion: this.specVersion,
        }),
      );
      if (!b.ok)
        return this.fail(
          s,
          `退避できなかったため、削除しませんでした：${b.message}`,
          b.folderName
            ? [`途中まで作成した退避フォルダ：${backupRoot.name}/${b.folderName}（自動では削除しません）`]
            : undefined,
        );
      const where = `${backupRoot.name}/${b.folderName}`;
      // 元側の再照合（19.1 手順6）
      const check = async (): Promise<{ ok: true; items: Fingerprint[] } | { ok: false; message: string }> => {
        const t = await enumerateTree(dir);
        if (!t.ok) return t;
        const f = await fingerprint(t.entries);
        if (!f.ok) return f;
        const d = sameFingerprints(b.manifest.entries, f.items);
        return d ? { ok: false, message: d } : { ok: true, items: f.items };
      };
      const c1 = await check();
      if (!c1.ok)
        return this.fail(s, `退避の後に記事フォルダが変わったため、削除しませんでした：${c1.message}`, [
          `退避は保持しています：${where}`,
        ]);
      const v2 = await this.ask({
        title: "退避を検証しました",
        message: `退避先：${where}（${b.totalBytes.toLocaleString()} バイト、検証 ${b.verifiedAt}）。記事「${title || "無題"}」（${id}）を削除しますか。`,
        details: ["削除したファイルは CMS からは戻せません。退避フォルダは自動では削除しません。"],
        buttons: [
          { label: "記事を削除する", value: "delete", variant: "danger" },
          { label: "キャンセル", value: "cancel" },
        ],
        initial: "cancel",
      });
      if (v2 !== "delete") {
        s.notice = { kind: "info", text: `削除を取り消しました。退避は保持しています：${where}` };
        return;
      }
      this.operation = "記事の削除：削除中（削除済みのファイルは戻りません）";
      const rep = await this.queue.run(async () => {
        // 実行直前の照合（19：確認時・退避検証時・実行直前）
        const c2 = await check();
        if (!c2.ok) return { stopped: c2.message };
        return deleteEntries(dir, c2.items, { parent: articles, name: id });
      });
      if ("stopped" in rep)
        return this.fail(s, `実行直前の確認で記事フォルダの変化を検出したため、削除しませんでした：${rep.stopped}`, [
          `退避は保持しています：${where}`,
        ]);
      finished = true;
      this.git?.changed(id);
      this.noteDiskChange();
      const text = s.text;
      if (rep.error === null) {
        if (this.scan) this.scan = { ...this.scan, entries: this.scan.entries.filter((e) => e.dirName !== id) };
        // 存在しない文書を通常保存できる記事として残さない（11.3）
        const ro = readOnlySession(
          id,
          text,
          `この記事は削除しました。退避先：${where}。原文のコピー・ダウンロードはできます。`,
        );
        ro.notice = { kind: "ok", text: `記事 ${id} を削除しました。退避先：${where}` };
        this.session = ro;
        this.announce(ro.notice.text);
      } else {
        const ro = readOnlySession(id, text, "削除の途中で失敗したため、記事は不完全な状態の可能性があります。");
        ro.notice = {
          kind: "error",
          text: `削除は完了していません：${rep.error}`,
          details: [
            ...rep.deleted.map((p) => `削除済み：${p}`),
            ...rep.remaining.map((p) => `残存：${p}`),
            ...rep.unknown.map((p) => `不明：${p}`),
            `退避は保持しています：${where}`,
            "一覧を再読み込みし、残存しているファイルを確認してから、もう一度削除を確認してください。",
          ],
        };
        this.session = ro;
        await this.refreshList();
      }
    } catch (e) {
      this.fail(s, `記事を削除できません：${fsErrorMessage(classifyFsError(e))}`);
    } finally {
      if (!finished || this.session === s) s.locked = null;
      this.operation = null;
    }
  }

  // -------------------------------------------------------------------------
  // 復旧ドラフト（33.4）

  /** ドラフトを編集として開く。ディスクへは自動で書かない。 */
  async openDraft(rec: DraftRecord): Promise<void> {
    const articles = this.articles;
    if (!articles || this.busy) return;
    if (!this.drafts || rec.ws !== this.drafts.wsId) return;
    if ((await sha256Hex(encodeUtf8(rec.text))) !== rec.checksum) {
      this.folderError = "このドラフトはチェックサムが一致しません（破損）。原文の退避だけができます。";
      return;
    }
    if (!(await this.confirmLeave())) return;
    if (rec.isNew) {
      const a = analyzeText(rec.text, null);
      const createdAt = a.schema?.values.createdAt;
      const id = a.schema?.values.id ?? rec.articleId;
      const s = new EditorSession({
        id,
        text: rec.text,
        base: null,
        isNew: true,
        ...(createdAt ? { newCreatedAt: createdAt } : {}),
      });
      s.notice = {
        kind: "info",
        text: "未保存の新規記事を復旧ドラフトから開きました。保存するまでディスクには何も作りません。",
      };
      this.session = s;
      await this.drafts.remove(rec);
      this.drafts.onEdit(s);
      return;
    }
    const r = await readArticle(articles, rec.articleId);
    if (r.kind !== "ok") {
      const s = readOnlySession(
        rec.articleId,
        rec.text,
        "元の記事ファイルを読み込めないため、ドラフトは閲覧のみです。原文を退避してください。",
      );
      this.session = s;
      return;
    }
    const loaded = textFromBytes(r.bytes);
    if (!loaded.ok) {
      this.session = readOnlySession(rec.articleId, rec.text, loaded.reason);
      return;
    }
    const hash = await sha256Hex(r.bytes);
    const s = new EditorSession({
      id: rec.articleId,
      text: loaded.text,
      base: { bytes: r.bytes, text: loaded.text, readAt: r.readAt, hash },
      isNew: false,
    });
    if (s.analysis.readOnlyReason !== null) {
      this.session = readOnlySession(rec.articleId, rec.text, s.analysis.readOnlyReason);
      return;
    }
    this.session = s;
    s.setText(rec.text, null);
    if (rec.baseHash !== null && rec.baseHash === hash) {
      s.notice = {
        kind: "info",
        text: "復旧ドラフトを開きました。ディスクはドラフト作成時の基準版のままです。保存するまでディスクは変わりません。",
      };
    } else {
      s.recoveryMismatch = true;
      await s.setConflict({ kind: "bytes", bytes: r.bytes }, Date.now());
      s.notice = {
        kind: "warn",
        text: "外部変更あり：ドラフト作成時の基準版と現在のディスクの内容が異なります。比較してから保存してください。",
        details: ["基準版の本文は保存していないため、比較はディスク版と編集中（ドラフト）の2版です。"],
      };
    }
    await this.drafts.remove(rec);
    this.drafts.onEdit(s);
  }
}

function readOnlySession(id: string, text: string, reason: string): EditorSession {
  const s = new EditorSession({ id, text, base: null, isNew: false, readOnlyReason: reason });
  s.notice = { kind: "warn", text: reason } satisfies Notice;
  return s;
}

/** 記事として正常かを問わず、同名エントリーの有無（5.2） */
async function entryExists(articles: DirHandleLike, name: string): Promise<boolean> {
  try {
    await articles.getDirectoryHandle(name);
    return true;
  } catch (e) {
    const k = classifyFsError(e);
    if (k === "not-found") return false;
    if (k === "type-mismatch") return true;
    throw e;
  }
}
