/**
 * 画面の条件（メディアクエリ）を、部品の表示の切り替えに使う（ADR-0015）。
 * 見た目だけの違いは CSS の @media で書く。ここを使うのは、条件によって部品の構成（どのボタンをどこに出すか）が変わるときだけ。
 * 値は CSS の @media と同じ式にして、見た目と構成が同時に切り替わるようにする。
 */

class MediaFlag {
  matches = $state(false);

  constructor(query: string) {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(query);
    this.matches = m.matches;
    m.addEventListener("change", (e) => (this.matches = e.matches));
  }
}

/** 狭い画面（60rem 以下：iPhone・iPad の縦）。一覧と編集を1度に1つ出し、記事の操作を画面の下のバーに置く */
export const narrowScreen = new MediaFlag("(max-width: 60rem)");

/** 指で操作する画面。書式の帯を、カーソルの近くではなく画面の下（キーボードの上）に付ける */
export const coarsePointer = new MediaFlag("(pointer: coarse)");
