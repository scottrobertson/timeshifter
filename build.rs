use std::path::Path;
use std::process::Command;

// The stylesheet is baked into the binary, so rebuild it whenever the templates or
// styles change. Tailwind only keeps the classes the templates actually use.
fn main() {
    println!("cargo:rerun-if-changed=styles");
    println!("cargo:rerun-if-changed=templates");
    println!("cargo:rerun-if-changed=static/app.js");

    let output = Path::new("static/style.css");
    let built = Command::new("tailwindcss")
        .args(["-i", "styles/input.css", "-o", "static/style.css", "--minify"])
        .status()
        .is_ok_and(|s| s.success());

    if !built && !output.exists() {
        panic!("static/style.css is missing and tailwindcss isn't installed (brew install tailwindcss)");
    }
    if !built {
        println!("cargo:warning=tailwindcss failed or isn't installed, using the existing static/style.css");
    }
}
