//! RUST-01: tree-sitter-al parsed natively, returned to JavaScript as flat arrays.
//! One call per file; the tree is freed before the call returns. Design section 4.
use napi::bindgen_prelude::{Int32Array, Uint16Array, Uint32Array, Uint8Array, Utf16String};
use napi_derive::napi;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use tree_sitter::{Language, Parser, Tree};

pub const GRAMMAR_VERSION: &str = "4.4.1";
pub const TREE_SITTER_VERSION: &str = "0.25.10";

pub const FLAG_NAMED: u8 = 1;
pub const FLAG_MISSING: u8 = 2;
pub const FLAG_HAS_ERROR: u8 = 4;
pub const FLAG_EXTRA: u8 = 8;

#[derive(Default)]
pub struct Flat {
    pub kind_names: Vec<String>,
    pub kind: Vec<u16>,
    pub field_names: Vec<String>,
    pub field: Vec<u16>,
    pub flags: Vec<u8>,
    pub child_count: Vec<u32>,
    pub next_sibling: Vec<i32>,
    pub start_index: Vec<u32>,
    pub end_index: Vec<u32>,
    pub points: Vec<u32>,
}

/// Maps a tree-sitter id (symbol or field) to an index in a per-file name table. A name is a
/// function of its id (ts_node_type is ts_language_symbol_name of ts_node_symbol), so mapping by
/// id is exact, including aliases, ERROR (id 65535) and MISSING nodes.
struct Interner {
    map: Vec<u16>,
    names: Vec<String>,
}

impl Interner {
    fn new(reserved: Option<&str>) -> Self {
        let names = reserved.map(|r| vec![r.to_string()]).unwrap_or_default();
        Self { map: vec![u16::MAX; 65536], names }
    }
    fn get(&mut self, id: u16, name: &str) -> u16 {
        let slot = &mut self.map[id as usize];
        if *slot == u16::MAX {
            *slot = self.names.len() as u16;
            self.names.push(name.to_string());
        }
        *slot
    }
}

fn language() -> Language {
    tree_sitter_al::LANGUAGE.into()
}

thread_local! {
    static PARSER: RefCell<Parser> = RefCell::new({
        let mut p = Parser::new();
        p.set_language(&language()).expect("tree-sitter-al's ABI is not supported by this tree-sitter runtime");
        p
    });
}

/// Preorder walk with a cursor. A node's first child is at index + 1; siblings link forward.
/// Offsets and columns are halved: the input is UTF-16, so tree-sitter counts 2 bytes per code unit.
pub fn flatten(tree: &Tree) -> Flat {
    let mut f = Flat::default();
    let mut kinds = Interner::new(None);
    let mut fields = Interner::new(Some(""));
    let mut cursor = tree.walk();
    let mut parents: Vec<usize> = Vec::new();
    let mut prev: Vec<Option<usize>> = vec![None];
    loop {
        let node = cursor.node();
        let i = f.kind.len();
        f.kind.push(kinds.get(node.kind_id(), node.kind()));
        f.field.push(match (cursor.field_id(), cursor.field_name()) {
            (Some(id), Some(name)) => fields.get(id.get(), name),
            _ => 0,
        });
        f.flags.push(
            (node.is_named() as u8) * FLAG_NAMED
                | (node.is_missing() as u8) * FLAG_MISSING
                | (node.has_error() as u8) * FLAG_HAS_ERROR
                | (node.is_extra() as u8) * FLAG_EXTRA,
        );
        f.child_count.push(0);
        f.next_sibling.push(-1);
        f.start_index.push((node.start_byte() / 2) as u32);
        f.end_index.push((node.end_byte() / 2) as u32);
        let (s, e) = (node.start_position(), node.end_position());
        f.points.extend_from_slice(&[s.row as u32, (s.column / 2) as u32, e.row as u32, (e.column / 2) as u32]);
        if let Some(&p) = parents.last() {
            f.child_count[p] += 1;
        }
        if let Some(Some(s)) = prev.last().copied() {
            f.next_sibling[s] = i as i32;
        }
        if let Some(last) = prev.last_mut() {
            *last = Some(i);
        }
        if cursor.goto_first_child() {
            parents.push(i);
            prev.push(None);
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                f.kind_names = kinds.names;
                f.field_names = fields.names;
                return f;
            }
            parents.pop();
            prev.pop();
        }
    }
}

pub fn parse_units(units: &[u16]) -> Flat {
    PARSER.with(|p| {
        let tree = p.borrow_mut().parse_utf16_le(units, None).expect("tree-sitter returned no tree");
        flatten(&tree)
    })
}

/// SHA-256 over every symbol name in id order, a marker, then every field name. The WASM side
/// computes the same digest from its Language (scripts/lib/parser-equivalence.ts).
pub fn kind_table_sha256() -> String {
    let lang = language();
    let mut h = Sha256::new();
    for id in 0..lang.node_kind_count() as u16 {
        h.update(lang.node_kind_for_id(id).unwrap_or(""));
        h.update(b"\n");
    }
    h.update(b"--fields--\n");
    for id in 1..=lang.field_count() as u16 {
        h.update(lang.field_name_for_id(id).unwrap_or(""));
        h.update(b"\n");
    }
    format!("{:x}", h.finalize())
}

#[napi(object)]
pub struct FlatTree {
    pub kind_names: Vec<String>,
    pub kind: Uint16Array,
    pub field_names: Vec<String>,
    pub field: Uint16Array,
    pub flags: Uint8Array,
    pub child_count: Uint32Array,
    pub next_sibling: Int32Array,
    pub start_index: Uint32Array,
    pub end_index: Uint32Array,
    pub points: Uint32Array,
}

#[napi(object)]
pub struct NativeInfo {
    pub binding_source_sha256: String,
    pub grammar_inputs: String,
    pub grammar_version: String,
    pub tree_sitter_version: String,
    pub language_abi: u32,
    pub kind_table_sha256: String,
    pub rustc_version: String,
    pub target: String,
    pub c_compiler: String,
}

#[napi]
pub fn parse_flat(source: Utf16String) -> FlatTree {
    let f = parse_units(&source);
    FlatTree {
        kind_names: f.kind_names,
        kind: Uint16Array::new(f.kind),
        field_names: f.field_names,
        field: Uint16Array::new(f.field),
        flags: Uint8Array::new(f.flags),
        child_count: Uint32Array::new(f.child_count),
        next_sibling: Int32Array::new(f.next_sibling),
        start_index: Uint32Array::new(f.start_index),
        end_index: Uint32Array::new(f.end_index),
        points: Uint32Array::new(f.points),
    }
}

#[napi]
pub fn native_info() -> NativeInfo {
    NativeInfo {
        binding_source_sha256: env!("LETHAL_BINDING_SOURCE_SHA256").to_string(),
        grammar_inputs: env!("LETHAL_GRAMMAR_INPUTS").to_string(),
        grammar_version: GRAMMAR_VERSION.to_string(),
        tree_sitter_version: TREE_SITTER_VERSION.to_string(),
        language_abi: language().abi_version() as u32,
        kind_table_sha256: kind_table_sha256(),
        rustc_version: env!("LETHAL_RUSTC_VERSION").to_string(),
        target: env!("LETHAL_TARGET").to_string(),
        c_compiler: env!("LETHAL_C_COMPILER").to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn root_is_source_file_and_links_are_consistent() {
        let f = parse_units(&units("codeunit 50100 X { procedure P() begin end; }"));
        assert_eq!(f.kind_names[f.kind[0] as usize], "source_file");
        let n = f.kind.len();
        assert_eq!(f.child_count.iter().map(|&c| c as usize).sum::<usize>(), n - 1);
        assert_eq!(f.next_sibling[0], -1);
        assert_eq!(f.points.len(), 4 * n);
        assert_eq!(f.field.len(), n);
    }

    #[test]
    fn offsets_are_utf16_code_units() {
        let src = "codeunit 50100 \"Blåbær😀\" { }";
        let f = parse_units(&units(src));
        assert_eq!(f.end_index[0] as usize, src.encode_utf16().count());
        // RUST-03: the quoted name ends after the emoji (2 code units) at unit 25, and `{` starts at
        // 26. Pins start_index and the column halving, not only the root's end.
        let name = (0..f.kind.len()).find(|&i| f.start_index[i] == 15 && f.end_index[i] == 25);
        let name = name.expect("a node spans the quoted name, units 15..25");
        assert_eq!(f.points[4 * name + 1], 15, "start column of the name");
        assert_eq!(f.points[4 * name + 3], 25, "end column after the emoji");
        let brace = (0..f.kind.len()).find(|&i| f.kind_names[f.kind[i] as usize] == "{");
        let brace = brace.expect("the `{` token is a node");
        assert_eq!(f.start_index[brace], 26);
        assert_eq!(f.points[4 * brace + 1], 26, "start column of `{{`");
    }

    #[test]
    fn field_zero_means_no_field() {
        let f = parse_units(&units("codeunit 50100 X { }"));
        assert_eq!(f.field_names[0], "");
        assert_eq!(f.field[0], 0);
        assert!(f.field.iter().any(|&x| x != 0), "an object declaration has named fields");
    }

    #[test]
    fn has_error_flag_on_broken_input() {
        let f = parse_units(&units("codeunit 50100 X { procedure P() begin if then end; }"));
        assert_ne!(f.flags[0] & FLAG_HAS_ERROR, 0);
    }

    #[test]
    fn empty_source_is_one_root_node() {
        let f = parse_units(&units(""));
        assert_eq!(f.kind.len(), 1);
        assert_eq!(f.child_count[0], 0);
    }

    #[test]
    fn kind_table_digest_is_hex_sha256() {
        let d = kind_table_sha256();
        assert_eq!(d.len(), 64);
        assert!(d.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
