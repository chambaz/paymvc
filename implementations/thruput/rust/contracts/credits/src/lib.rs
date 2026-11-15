//! PayMVC demo credits: the SDK's example ERC-20 with metadata.
//!
//! The administrator is the only minter. PayMVC initializes this token with
//! its own address as administrator and zero decimals, so only PayMVC
//! registration can create credits.

#![cfg_attr(not(feature = "dev"), no_std)]

thruput_sdk::declare_mock_contract!();

mod implementation;

pub use implementation::Credits;
pub use thruput_erc20_if::{ERC20, ERC20Client, ERC20Error};
pub use thruput_erc20_metadata_if::{ERC20Metadata, ERC20MetadataClient, Name, Symbol};
