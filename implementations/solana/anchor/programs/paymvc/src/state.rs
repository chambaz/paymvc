use anchor_lang::prelude::*;

/// One per registered account, at `[b"profile", owner]`.
#[account]
#[derive(InitSpace)]
pub struct Profile {
    pub owner: Pubkey,
    /// The number of activity records, and the index of the next one.
    pub activity_count: u64,
}

/// The directory count, at `[b"directory"]`.
#[account]
#[derive(InitSpace)]
pub struct Directory {
    pub count: u64,
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
}

/// One activity record, at `[b"activity", owner, index]`. Points to an entry.
#[account]
#[derive(InitSpace)]
pub struct Activity {
    pub entry: Pubkey,
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
