use anchor_lang::prelude::*;

/// Activity records per activity account.
pub const ACTIVITY_PAGE: u64 = 32;

/// One per registered account, at `[b"profile", owner]`.
#[account]
#[derive(InitSpace)]
pub struct Profile {
    pub owner: Pubkey,
    /// The number of activity records, and the index of the next one.
    pub activity_count: u64,
    pub bump: u8,
}

/// The directory count, at `[b"directory"]`.
#[account]
#[derive(InitSpace)]
pub struct Directory {
    pub count: u64,
    pub bump: u8,
}

/// One per registration, at `[b"member", index]`. Never moves.
#[account]
#[derive(InitSpace)]
pub struct Member {
    pub owner: Pubkey,
}

/// One transfer or request, at `[b"entry", from, operation]`.
#[account]
#[derive(InitSpace)]
pub struct Entry {
    pub from: Pubkey,
    pub to: Pubkey,
    pub operation: [u8; 32],
    pub amount: u64,
    pub kind: Kind,
    pub state: State,
    pub bump: u8,
}

/// Up to `ACTIVITY_PAGE` activity records of one account, at `[b"activity", owner, page]`.
/// Record `i` is entry address `entries[i % ACTIVITY_PAGE]` in page `i / ACTIVITY_PAGE`.
/// Pages let concurrent payments to one account land, except across a page boundary.
#[account]
#[derive(InitSpace)]
pub struct Activity {
    pub entries: [Pubkey; ACTIVITY_PAGE as usize],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Kind {
    Transfer,
    Request,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum State {
    Pending,
    Paid,
    Declined,
}
