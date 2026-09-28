//! RUST-03: the native half of R-236c's "every tree released" intent. The tree must be freed
//! inside parse_units, so tree-sitter's live C allocations return to the same level after every
//! call. Own process (integration test), because set_allocator is global.
use std::alloc::{alloc, dealloc, realloc as sys_realloc, Layout};
use std::sync::atomic::{AtomicIsize, Ordering};

static LIVE: AtomicIsize = AtomicIsize::new(0);
const HDR: usize = 16;

unsafe extern "C" fn m(n: usize) -> *mut std::ffi::c_void {
    let p = alloc(Layout::from_size_align_unchecked(n + HDR, HDR));
    *(p as *mut usize) = n;
    LIVE.fetch_add(n as isize, Ordering::SeqCst);
    p.add(HDR) as *mut _
}
unsafe extern "C" fn c(k: usize, n: usize) -> *mut std::ffi::c_void {
    let p = m(k * n) as *mut u8;
    std::ptr::write_bytes(p, 0, k * n);
    p as *mut _
}
unsafe extern "C" fn f(p: *mut std::ffi::c_void) {
    if p.is_null() { return; }
    let base = (p as *mut u8).sub(HDR);
    let n = *(base as *mut usize);
    LIVE.fetch_sub(n as isize, Ordering::SeqCst);
    dealloc(base, Layout::from_size_align_unchecked(n + HDR, HDR));
}
unsafe extern "C" fn r(p: *mut std::ffi::c_void, n: usize) -> *mut std::ffi::c_void {
    if p.is_null() { return m(n); }
    let base = (p as *mut u8).sub(HDR);
    let old = *(base as *mut usize);
    let q = sys_realloc(base, Layout::from_size_align_unchecked(old + HDR, HDR), n + HDR);
    *(q as *mut usize) = n;
    LIVE.fetch_add(n as isize - old as isize, Ordering::SeqCst);
    q.add(HDR) as *mut _
}

#[test]
fn every_call_frees_its_tree() {
    unsafe { tree_sitter::set_allocator(Some(m), Some(c), Some(r), Some(f)) };
    let src: Vec<u16> = "codeunit 50100 X { procedure P() begin if true then exit; end; }".encode_utf16().collect();
    lethal_parser::parse_units(&src); // warm: the thread-local parser allocates once
    let base = LIVE.load(Ordering::SeqCst);
    for _ in 0..1000 {
        let flat = lethal_parser::parse_units(&src);
        assert!(flat.kind.len() > 1);
        assert_eq!(LIVE.load(Ordering::SeqCst), base, "a parse left C memory allocated");
    }
}
