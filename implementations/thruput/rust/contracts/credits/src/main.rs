//! RV32 binary wrapper for the `credits` contract library.
//!
//! `thruput build -p credits` builds this bin with the `entrypoints` feature.
//! Referencing the library links the macro-emitted entrypoints. The runtime
//! arrives through `thruput-sdk`.

#![no_std]
#![no_main]

extern crate credits;
