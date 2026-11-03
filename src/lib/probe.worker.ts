/// <reference lib="webworker" />
// 隔離処理（Worker）が file:// 起動と CSP の下で実際に動くかを確かめるための最小Worker。
self.onmessage = (event: MessageEvent<unknown>) => {
  self.postMessage({ echo: event.data });
};
