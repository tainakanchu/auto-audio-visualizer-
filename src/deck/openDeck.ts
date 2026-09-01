/**
 * Scene Deck 窓を開く。
 *
 * `window.open(url, name)` は同名の窓が既にあると focus ではなく再ナビゲートする。
 * デッキ窓はバンク（ガチャ結果 / 選択中 transition）をメモリにしか持たないので、
 * `S` の二度押しで作り直されると本番中に手札が消える。開いた Window を保持し、
 * 生きていれば focus だけにする。
 */
const DECK_WINDOW_NAME = 'vj-scene-deck';
const DECK_WINDOW_FEATURES = 'width=1000,height=640';

let deckWindow: Window | null = null;

export function openSceneDeck(): void {
  if (deckWindow !== null && !deckWindow.closed) {
    deckWindow.focus();
    return;
  }
  deckWindow = window.open(location.pathname + '?deck=1', DECK_WINDOW_NAME, DECK_WINDOW_FEATURES);
}
