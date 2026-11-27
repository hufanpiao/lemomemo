// 生成 Tauri 上下文和本 App 自己命令的权限（allow-<命令名>）。
// 命令名单在 src/commands.rs（和 generate_handler! 由单测核对一致）；
// 页面能调哪些命令只由 capabilities/*.json 按窗口给（架构 5.10“Tauri 权限”）。
include!("src/commands.rs");

fn main() {
    println!("cargo:rerun-if-changed=src/commands.rs");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("tauri-build 失败");
}
