import { mount } from "svelte";
import App from "./App.svelte";
import PasskeyCheck from "./components/PasskeyCheck.svelte";
import { watchKeyboard } from "./lib/ui/viewport";
import "./app.css";

// 画面キーボードの高さを CSS へ渡す（下に固定した部品をキーボードの上に載せるため：ADR-0015）
watchKeyboard(window, document.documentElement);

const target = document.getElementById("app");
if (!target) throw new Error("#app element not found");

// `?passkey-check` でパスキーの確認ページを開く（作業場所には触れない）
const page = new URLSearchParams(location.search).has("passkey-check") ? PasskeyCheck : App;

export default mount(page, { target });
