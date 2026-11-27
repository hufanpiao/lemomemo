// B0 小验证：只开一个窗口加载打包进来的 dist/index.html，不注册任何命令、不开任何插件。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Turnstile 小验证壳启动失败");
}
