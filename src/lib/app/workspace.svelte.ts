/**
 * 作業フォルダ全体の状態と操作（仕様 3・10.1・11・12・13・23）。
 */
import { allocateArticleId, generateArticleId } from "../core/article-id";
import { newArticleText, textFromBytes, type Problem } from "../core/article-doc";
import { sha256Hex } from "../core/bytes";
import { nowDateTime } from "../core/datetime";
import { checkSlugUniqueness } from "../core/slug";
import {
  canCreateArticles,
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
import { createArticle, readDiskArticle, saveExisting, SerialQueue, type DiskClass } from "../fs/save";
import { classifyFsError, fsErrorMessage, type DirHandleLike } from "../fs/types";
import { EditorSession, problemsNotice, type Notice } from "./session.svelte";

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

type PickerHost = { showDirectoryPicker?: (o?: { mode?: "read" | "readwrite" }) => Promise<unknown> };

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
  session = $state<EditorSession | null>(null);
  dialog = $state<DialogRequest | null>(null);
  /** 支援技術へ通知する短い状態文（14.1） */
  announcement = $state("");
  opening = $state(false);

  readonly queue = new SerialQueue();
  /** このセッションで作成した記事フォルダ（新規作成の再試行で所有を判断する） */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 画面に表示しない内部状態
  private readonly ownedDirs = new Set<string>();

  constructor(private readonly host: PickerHost = globalThis as unknown as PickerHost) {}

  get busy(): boolean {
    return this.scanning || this.opening || (this.session?.saving ?? false);
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
  }

  async openRoot(root: DirHandleLike): Promise<void> {
    this.session = null;
    this.root = root;
    this.rootName = root.name;
    this.folderError = null;
    this.articles = null;
    this.missingArticles = false;
    this.scan = null;
    this.config = await readConfig(root);
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
        "ブラウザ内の復旧ドラフトは未実装のため、破棄した編集は復旧できません。",
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
      const ro = s.analysis.readOnlyReason;
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
    // 1. スナップショットとリビジョンを固定する
    let snapshot = s.text;
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
          text: "外部変更あり：読み込み後にディスク上のファイルが変わったため、保存を止めました。",
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

  private async refreshEntry(id: string): Promise<void> {
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
    if (v === "ok") await this.loadArticle(s.id);
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
