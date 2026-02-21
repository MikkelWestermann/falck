fn main() {
    let _ = dotenvy::dotenv();
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let _ = dotenvy::from_path(std::path::Path::new(&manifest_dir).join("../.env"));
    }
    if let Ok(id) = std::env::var("GITHUB_CLIENT_ID").or_else(|_| std::env::var("FALCK_GITHUB_CLIENT_ID")) {
        println!("cargo:rustc-env=GITHUB_CLIENT_ID={}", id);
    }
    tauri_build::build()
}
