use std::time::Instant;
fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() { walk(&p, out) } else if p.extension().map_or(false, |x| x.eq_ignore_ascii_case("al")) { out.push(p) }
    }
}
fn main() {
    let dir = std::env::args().nth(1).unwrap();
    let mut files = Vec::new();
    walk(std::path::Path::new(&dir), &mut files);
    let srcs: Vec<Vec<u16>> = files.iter().map(|f| String::from_utf8_lossy(&std::fs::read(f).unwrap()).encode_utf16().collect()).collect();
    let mut p = tree_sitter::Parser::new();
    p.set_language(&tree_sitter_al::LANGUAGE.into()).unwrap();
    let (mut parse, mut flat, mut nodes) = (0f64, 0f64, 0usize);
    for s in &srcs {
        let t0 = Instant::now();
        let tree = p.parse_utf16_le(s, None).unwrap();
        let t1 = Instant::now();
        nodes += lethal_parser::flatten(&tree).kind.len();
        parse += (t1 - t0).as_secs_f64();
        flat += t1.elapsed().as_secs_f64();
    }
    println!("files {} nodes {} parseMs {:.0} flattenMs {:.0}", srcs.len(), nodes, parse * 1e3, flat * 1e3);
}
