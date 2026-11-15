extern crate alloc;

use alloc::vec::Vec;
use thruput_erc20_if::ERC20Client;
use thruput_erc20_metadata_if::{ERC20MetadataClient, Name, Symbol};
use thruput_sdk::storage::{Map, Value, Vector};
use thruput_sdk::*;

/// Credits that registration allocates, once per account.
pub const ALLOCATION: i128 = 100;
/// The largest send or request amount.
pub const MAX_AMOUNT: i128 = 1_000_000;
/// The most addresses one `profiles` call returns. A page must fit the
/// runtime's return buffer.
pub const PROFILE_PAGE: u64 = 25;
/// The most entries one `activity` call returns. A page must fit the
/// runtime's return buffer.
pub const ACTIVITY_PAGE: u64 = 5;

#[contract_exception]
pub enum PaymentError {
    AlreadyRegistered = 1,
    NotRegistered = 2,
    InvalidParticipants = 3,
    InvalidAmount = 4,
    InvalidOperation = 5,
    OperationUsed = 6,
    NotFound = 7,
    Unauthorized = 8,
    NotPending = 9,
    InvalidPage = 10,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[contract_type]
pub enum Kind {
    Transfer = 0,
    Request = 1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[contract_type]
pub enum State {
    Pending = 0,
    Paid = 1,
    Declined = 2,
}

/// One transfer or request. Its key is `(from, operation)`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[contract_type]
pub struct Entry {
    pub from: ContractAddress,
    pub to: ContractAddress,
    pub operation: SHA256Hash,
    pub amount: i128,
    pub kind: Kind,
    pub state: State,
}

/// The key of an entry in an account's history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[contract_type]
pub struct EntryKey {
    pub from: ContractAddress,
    pub operation: SHA256Hash,
}

#[derive(Debug)]
#[thruput_sdk::storage]
pub struct PayMVC {
    credits: Value<ContractAddress>,
    registered: Map<ContractAddress, Value<bool>>,
    directory: Vector<Value<ContractAddress>>,
    entries: Map<ContractAddress, Map<SHA256Hash, Value<Entry>>>,
    history: Map<ContractAddress, Vector<Value<EntryKey>>>,
}

#[contract(client = PayMVCClient, throws = PaymentError)]
impl PayMVC {
    /// Bind the credits token and make this contract its only minter.
    /// The deployment runs this atomically. A token that someone else has
    /// already initialized fails the whole deployment.
    pub fn initialize(&mut self, credits: &ContractAddress) {
        ensure(
            self.credits.try_get().none_if_missing().is_none(),
            PaymentError::Unauthorized,
        );
        self.credits.set(credits);
        ERC20MetadataClient::new(credits).initialize(
            &get_current_address(),
            Some(Name::try_from("PayMVC Credits").unwrap()),
            Some(Symbol::try_from("CREDITS").unwrap()),
            Some(0),
        );
    }

    #[contract(effect = "readOnly")]
    pub fn credits(&self) -> ContractAddress {
        self.credits.get()
    }

    pub fn register(&mut self) {
        let caller = get_caller();
        ensure(!self.registered(&caller), PaymentError::AlreadyRegistered);
        // Identical ordinary writes can merge. Registration must have one winner.
        self.registered.at_mut(&caller).set_exclusive(&true);
        self.directory.push_with(|item| item.set(&caller));
        self.token().mint(&caller, ALLOCATION);
    }

    /// Pay `to` from the caller's credits. The caller first allows this
    /// contract to spend `amount`, in the same transaction.
    pub fn send(&mut self, to: &ContractAddress, amount: i128, operation: &SHA256Hash) {
        let from = get_caller();
        self.create(&from, to, amount, operation, Kind::Transfer);
        self.token().transfer_from(&from, to, amount);
    }

    pub fn request(&mut self, payer: &ContractAddress, amount: i128, operation: &SHA256Hash) {
        self.create(&get_caller(), payer, amount, operation, Kind::Request);
    }

    /// Pay a pending request. The payer first allows this contract to spend
    /// the amount, in the same transaction.
    pub fn approve(&mut self, from: &ContractAddress, operation: &SHA256Hash) {
        let entry = self.resolve(from, operation, State::Paid);
        self.token()
            .transfer_from(&entry.to, &entry.from, entry.amount);
    }

    pub fn decline(&mut self, from: &ContractAddress, operation: &SHA256Hash) {
        self.resolve(from, operation, State::Declined);
    }

    #[contract(effect = "readOnly")]
    pub fn registered(&self, account: &ContractAddress) -> bool {
        self.registered
            .at(account)
            .try_get()
            .none_if_missing()
            .unwrap_or(false)
    }

    #[contract(effect = "readOnly")]
    pub fn profile_count(&self) -> u64 {
        self.directory.len().into()
    }

    /// Registered addresses in registration order.
    #[contract(effect = "readOnly")]
    pub fn profiles(&self, start: u64, limit: u64) -> Vec<ContractAddress> {
        ensure(
            (1..=PROFILE_PAGE).contains(&limit),
            PaymentError::InvalidPage,
        );
        let end = start.saturating_add(limit).min(self.profile_count());
        (start..end)
            .map(|i| self.directory.at(i as u32).get())
            .collect()
    }

    #[contract(effect = "readOnly")]
    pub fn entry(&self, from: &ContractAddress, operation: &SHA256Hash) -> Option<Entry> {
        self.entries
            .at(from)
            .at(operation)
            .try_get()
            .none_if_missing()
    }

    #[contract(effect = "readOnly")]
    pub fn activity_count(&self, account: &ContractAddress) -> u64 {
        self.history.at(account).len().into()
    }

    /// Newest first: the entries at history index `< before`. Start with
    /// `before = activity_count`. History only grows, so a new entry never
    /// shifts a later page.
    #[contract(effect = "readOnly")]
    pub fn activity(&self, account: &ContractAddress, before: u64, limit: u64) -> Vec<Entry> {
        ensure(
            (1..=ACTIVITY_PAGE).contains(&limit),
            PaymentError::InvalidPage,
        );
        let history = self.history.at(account);
        let end = before.min(history.len().into());
        (end.saturating_sub(limit)..end)
            .rev()
            .map(|i| {
                let key = history.at(i as u32).get();
                self.entries.at(&key.from).at(&key.operation).get()
            })
            .collect()
    }
}

impl PayMVC {
    fn token(&self) -> ERC20Client {
        ERC20Client::new(&self.credits.get())
    }

    fn create(
        &mut self,
        from: &ContractAddress,
        to: &ContractAddress,
        amount: i128,
        operation: &SHA256Hash,
        kind: Kind,
    ) {
        ensure(
            (1..=MAX_AMOUNT).contains(&amount),
            PaymentError::InvalidAmount,
        );
        ensure(
            *operation != SHA256Hash::new([0; 32]),
            PaymentError::InvalidOperation,
        );
        ensure(from != to, PaymentError::InvalidParticipants);
        ensure(
            self.registered(from) && self.registered(to),
            PaymentError::NotRegistered,
        );
        ensure(
            self.entry(from, operation).is_none(),
            PaymentError::OperationUsed,
        );
        let entry = Entry {
            from: *from,
            to: *to,
            operation: *operation,
            amount,
            kind,
            state: match kind {
                Kind::Transfer => State::Paid,
                Kind::Request => State::Pending,
            },
        };
        // The exclusive write lets one entry win per `(from, operation)`.
        self.entries
            .at_mut(from)
            .at_mut(operation)
            .set_exclusive(&entry);
        let key = EntryKey {
            from: *from,
            operation: *operation,
        };
        self.history.at_mut(from).push_with(|item| item.set(&key));
        self.history.at_mut(to).push_with(|item| item.set(&key));
    }

    /// Mark a pending request `state`. Only its intended payer can do this.
    fn resolve(&mut self, from: &ContractAddress, operation: &SHA256Hash, state: State) -> Entry {
        let mut entry = self
            .entry(from, operation)
            .unwrap_or_else(|| throw(PaymentError::NotFound));
        ensure(entry.to == get_caller(), PaymentError::Unauthorized);
        ensure(
            entry.kind == Kind::Request && entry.state == State::Pending,
            PaymentError::NotPending,
        );
        entry.state = state;
        // The exclusive write lets at most one resolution win.
        self.entries
            .at_mut(from)
            .at_mut(operation)
            .set_exclusive(&entry);
        entry
    }
}
