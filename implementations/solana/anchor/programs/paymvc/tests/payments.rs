use anchor_lang::{
    error::ErrorCode,
    prelude::Pubkey,
    solana_program::{instruction::Instruction, system_program},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use anchor_spl::{
    associated_token::{get_associated_token_address, ID as ASSOCIATED_TOKEN_ID},
    token::{spl_token, TokenAccount, ID as TOKEN_ID},
};
use litesvm::LiteSVM;
use paymvc::{
    state::{Activity, Directory, Entry, Kind, Member, Profile, State, ACTIVITY_PAGE},
    PayError,
};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_error::TransactionError;

/// The System Program's AccountAlreadyInUse: `init` on an existing account.
/// This is AlreadyRegistered for a profile and OperationUsed for an entry.
const ALREADY_IN_USE: u32 = 0;
/// SPL Token's InsufficientFunds.
const INSUFFICIENT_FUNDS: u32 = 1;

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &paymvc::ID).0
}
fn profile(owner: Pubkey) -> Pubkey {
    pda(&[b"profile", owner.as_ref()])
}
fn mint() -> Pubkey {
    pda(&[b"mint"])
}
fn credits(owner: Pubkey) -> Pubkey {
    get_associated_token_address(&owner, &mint())
}
fn entry(from: Pubkey, op: u8) -> Pubkey {
    pda(&[b"entry", from.as_ref(), &[op; 32]])
}
/// The activity page that holds record `index`.
fn activity(owner: Pubkey, index: u64) -> Pubkey {
    pda(&[
        b"activity",
        owner.as_ref(),
        &(index / ACTIVITY_PAGE).to_le_bytes(),
    ])
}
fn ix(data: impl InstructionData, accounts: impl ToAccountMetas) -> Instruction {
    Instruction::new_with_bytes(paymvc::ID, &data.data(), accounts.to_account_metas(None))
}
/// The custom error code of a failed transaction.
fn code(result: Result<(), TransactionError>) -> u32 {
    match result {
        Err(TransactionError::InstructionError(_, InstructionError::Custom(code))) => code,
        other => panic!("expected a custom error, got {other:?}"),
    }
}
fn pay(error: PayError) -> u32 {
    error.into()
}
fn not_initialized() -> u32 {
    ErrorCode::AccountNotInitialized.into()
}
fn anchor(error: ErrorCode) -> u32 {
    error.into()
}

struct Demo {
    svm: LiteSVM,
    people: [Keypair; 8],
}
impl Demo {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(
            paymvc::ID,
            &std::fs::read("../../target/deploy/paymvc.so").expect("Run anchor build first"),
        )
        .unwrap();
        let people = std::array::from_fn(|_| Keypair::new());
        for person in &people {
            svm.airdrop(&person.pubkey(), 2_000_000_000).unwrap();
        }
        let mut demo = Self { svm, people };
        demo.run(0, demo.initialize_ix(0)).unwrap();
        for i in 0..6 {
            demo.register(i).unwrap();
        }
        demo
    }
    fn key(&self, i: usize) -> Pubkey {
        self.people[i].pubkey()
    }
    fn initialize_ix(&self, payer: usize) -> Instruction {
        ix(
            paymvc::instruction::Initialize {},
            paymvc::accounts::Initialize {
                payer: self.key(payer),
                directory: pda(&[b"directory"]),
                mint: mint(),
                authority: pda(&[b"authority"]),
                token_program: TOKEN_ID,
                system_program: system_program::ID,
            },
        )
    }
    /// Runs instructions that also need the signatures in `extra`.
    fn run_signed(
        &mut self,
        actor: usize,
        instructions: &[Instruction],
        extra: &[&Keypair],
    ) -> Result<(), TransactionError> {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(
            instructions,
            Some(&self.key(actor)),
            &self.svm.latest_blockhash(),
        );
        let mut signers = vec![&self.people[actor]];
        signers.extend_from_slice(extra);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &signers).unwrap();
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| e.err)
    }
    fn run(&mut self, actor: usize, instruction: Instruction) -> Result<(), TransactionError> {
        self.measure(actor, instruction).map(|_| ())
    }
    /// Runs one instruction and returns the compute units it used.
    fn measure(&mut self, actor: usize, instruction: Instruction) -> Result<u64, TransactionError> {
        // Distinct blockhashes let tests reach program constraints instead of signature deduplication.
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(
            &[instruction],
            Some(&self.key(actor)),
            &self.svm.latest_blockhash(),
        );
        let tx =
            VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&self.people[actor]])
                .unwrap();
        self.svm
            .send_transaction(tx)
            .map(|meta| meta.compute_units_consumed)
            .map_err(|e| e.err)
    }
    fn read<T: AccountDeserialize>(&self, address: Pubkey) -> Option<T> {
        let account = self.svm.get_account(&address)?;
        Some(T::try_deserialize(&mut account.data.as_slice()).unwrap())
    }
    fn balance(&self, i: usize) -> u64 {
        self.read::<TokenAccount>(credits(self.key(i)))
            .unwrap()
            .amount
    }
    fn count(&self, i: usize) -> u64 {
        self.read::<Profile>(profile(self.key(i)))
            .unwrap()
            .activity_count
    }
    fn directory(&self) -> u64 {
        self.read::<Directory>(pda(&[b"directory"])).unwrap().count
    }
    /// The canonical `entry(from, operation)` read: an account that may not exist.
    fn entry(&self, from: usize, op: u8) -> Option<Entry> {
        self.read(entry(self.key(from), op))
    }
    fn state(&self, from: usize, op: u8) -> State {
        self.entry(from, op).unwrap().state
    }
    /// The canonical `activity(account, before, limit)` read, as the client does it:
    /// entry addresses with history index < `before`, newest first.
    fn activity(&self, owner: usize, before: u64, limit: u64) -> Vec<Pubkey> {
        (before.saturating_sub(limit)..before)
            .rev()
            .map(|index| {
                self.read::<Activity>(activity(self.key(owner), index))
                    .unwrap()
                    .entries[(index % ACTIVITY_PAGE) as usize]
            })
            .collect()
    }

    fn register_ix(&self, i: usize) -> Instruction {
        ix(
            paymvc::instruction::Register {},
            paymvc::accounts::Register {
                owner: self.key(i),
                profile: profile(self.key(i)),
                directory: pda(&[b"directory"]),
                member: pda(&[b"member", &self.directory().to_le_bytes()]),
                mint: mint(),
                authority: pda(&[b"authority"]),
                credits: credits(self.key(i)),
                token_program: TOKEN_ID,
                associated_token_program: ASSOCIATED_TOKEN_ID,
                system_program: system_program::ID,
            },
        )
    }
    fn register(&mut self, i: usize) -> Result<(), TransactionError> {
        self.run(i, self.register_ix(i))
    }
    fn send_ix(&self, from: usize, to: usize, op: u8, amount: u64) -> Instruction {
        let (from, to) = (self.key(from), self.key(to));
        ix(
            paymvc::instruction::Send {
                to,
                amount,
                operation: [op; 32],
            },
            paymvc::accounts::Send {
                from,
                from_profile: profile(from),
                to_profile: profile(to),
                entry: entry(from, op),
                from_activity: activity(from, self.activity_count(from)),
                to_activity: activity(to, self.activity_count(to)),
                mint: mint(),
                from_credits: credits(from),
                to_credits: credits(to),
                token_program: TOKEN_ID,
                system_program: system_program::ID,
            },
        )
    }
    fn send(
        &mut self,
        from: usize,
        to: usize,
        op: u8,
        amount: u64,
    ) -> Result<(), TransactionError> {
        self.run(from, self.send_ix(from, to, op, amount))
    }
    fn request_ix(&self, from: usize, payer: usize, op: u8, amount: u64) -> Instruction {
        let (from, payer) = (self.key(from), self.key(payer));
        ix(
            paymvc::instruction::Request {
                payer,
                amount,
                operation: [op; 32],
            },
            paymvc::accounts::Request {
                from,
                from_profile: profile(from),
                payer_profile: profile(payer),
                entry: entry(from, op),
                from_activity: activity(from, self.activity_count(from)),
                payer_activity: activity(payer, self.activity_count(payer)),
                system_program: system_program::ID,
            },
        )
    }
    fn request(
        &mut self,
        from: usize,
        payer: usize,
        op: u8,
        amount: u64,
    ) -> Result<(), TransactionError> {
        self.run(from, self.request_ix(from, payer, op, amount))
    }
    fn approve(&mut self, payer: usize, from: usize, op: u8) -> Result<(), TransactionError> {
        self.run(payer, self.approve_ix(payer, from, op))
    }
    fn approve_ix(&self, payer: usize, from: usize, op: u8) -> Instruction {
        let (payer_key, from_key) = (self.key(payer), self.key(from));
        ix(
            paymvc::instruction::Approve {
                from: from_key,
                operation: [op; 32],
            },
            paymvc::accounts::Approve {
                payer: payer_key,
                entry: entry(from_key, op),
                mint: mint(),
                payer_credits: credits(payer_key),
                from_credits: credits(from_key),
                token_program: TOKEN_ID,
            },
        )
    }
    fn decline_ix(&self, payer: usize, from: usize, op: u8) -> Instruction {
        ix(
            paymvc::instruction::Decline {
                from: self.key(from),
                operation: [op; 32],
            },
            paymvc::accounts::Decline {
                payer: self.key(payer),
                entry: entry(self.key(from), op),
            },
        )
    }
    fn decline(&mut self, payer: usize, from: usize, op: u8) -> Result<(), TransactionError> {
        self.run(payer, self.decline_ix(payer, from, op))
    }
    /// The activity count of any address. Unregistered addresses have none.
    fn activity_count(&self, owner: Pubkey) -> u64 {
        self.read::<Profile>(profile(owner))
            .map_or(0, |p| p.activity_count)
    }
    fn transfer(&mut self, from: usize, to: Pubkey, amount: u64) -> Result<(), TransactionError> {
        let external = spl_token::instruction::transfer_checked(
            &TOKEN_ID,
            &credits(self.key(from)),
            &mint(),
            &to,
            &self.key(from),
            &[],
            amount,
            0,
        )
        .unwrap();
        self.run(from, external)
    }
}

#[test]
fn canonical_scenario_preserves_real_balances_and_activity() {
    let mut d = Demo::new();
    d.send(0, 1, 1, 7).unwrap();
    assert_eq!((d.balance(0), d.balance(1)), (93, 107));
    d.request(1, 0, 2, 20).unwrap();
    d.approve(0, 1, 2).unwrap();
    d.request(1, 0, 3, 5).unwrap();
    d.decline(0, 1, 3).unwrap();
    d.request(0, 1, 4, 9).unwrap();
    d.approve(1, 0, 4).unwrap();
    assert_eq!((d.balance(0), d.balance(1)), (82, 118));
    assert_eq!((d.count(0), d.count(1)), (4, 4));
    assert_eq!((0..6).map(|i| d.balance(i)).sum::<u64>(), 600);
    assert_eq!(
        d.activity(0, 4, 50),
        [
            entry(d.key(0), 4),
            entry(d.key(1), 3),
            entry(d.key(1), 2),
            entry(d.key(0), 1)
        ]
    );
}

#[test]
fn entries_have_the_canonical_shape() {
    let mut d = Demo::new();
    assert!(d.entry(0, 1).is_none());
    d.send(0, 1, 1, 7).unwrap();
    d.request(0, 1, 2, 9).unwrap();
    let transfer = d.entry(0, 1).unwrap();
    assert_eq!((transfer.from, transfer.to), (d.key(0), d.key(1)));
    assert_eq!((transfer.operation, transfer.amount), ([1; 32], 7));
    assert!(transfer.kind == Kind::Transfer && transfer.state == State::Paid);
    let request = d.entry(0, 2).unwrap();
    assert_eq!(
        (request.from, request.to, request.amount),
        (d.key(0), d.key(1), 9)
    );
    assert!(request.kind == Kind::Request && request.state == State::Pending);
}

#[test]
fn registration_cannot_repeat_allocation() {
    let mut d = Demo::new();
    assert_eq!(code(d.register(0)), ALREADY_IN_USE);
    assert_eq!(d.balance(0), 100);
    assert_eq!(d.directory(), 6);
    for index in 0u64..6 {
        let member: Member = d.read(pda(&[b"member", &index.to_le_bytes()])).unwrap();
        assert_eq!(member.owner, d.key(index as usize));
    }
}

#[test]
fn concurrent_registration_requires_a_fresh_directory_cursor() {
    let mut d = Demo::new();
    let stale = d.register_ix(7);
    d.register(6).unwrap();
    // The member address no longer matches the directory count.
    assert_eq!(code(d.run(7, stale)), u32::from(ErrorCode::ConstraintSeeds));
    assert!(d.svm.get_account(&profile(d.key(7))).is_none());
    assert!(d.svm.get_account(&credits(d.key(7))).is_none());
    d.register(7).unwrap();
    assert_eq!(d.directory(), 8);
    let member: Member = d.read(pda(&[b"member", &7u64.to_le_bytes()])).unwrap();
    assert_eq!(member.owner, d.key(7));
    assert_eq!(d.balance(7), 100);
}

#[test]
fn registration_requires_the_owners_signature() {
    let mut d = Demo::new();
    let mut instruction = d.register_ix(6);
    instruction.accounts[0].is_signer = false;
    assert!(d.run(7, instruction).is_err());
    assert_eq!(d.directory(), 6);
    assert!(d.svm.get_account(&profile(d.key(6))).is_none());
}

#[test]
fn duplicate_operation_cannot_pay_or_request_twice() {
    let mut d = Demo::new();
    d.send(0, 1, 1, 10).unwrap();
    assert_eq!(code(d.send(0, 1, 1, 10)), ALREADY_IN_USE);
    assert_eq!(code(d.request(0, 2, 1, 50)), ALREADY_IN_USE);
    assert_eq!(d.balance(0), 90);
    assert_eq!(d.count(0), 1);
    // Operation IDs are scoped to the sender, so another sender can use the same ID.
    d.send(1, 0, 1, 10).unwrap();
}

#[test]
fn zero_operation_is_rejected_without_changing_balances() {
    let mut d = Demo::new();
    assert_eq!(code(d.send(0, 1, 0, 10)), pay(PayError::InvalidOperation));
    assert_eq!(
        code(d.request(0, 1, 0, 10)),
        pay(PayError::InvalidOperation)
    );
    assert_eq!(d.balance(0), 100);
    assert_eq!(d.count(0), 0);
    assert!(d.entry(0, 0).is_none());
}

#[test]
fn invalid_amounts_and_insufficient_funds_roll_back_records() {
    let mut d = Demo::new();
    for amount in [0, 1_000_001, u64::MAX] {
        assert_eq!(code(d.send(0, 1, 1, amount)), pay(PayError::InvalidAmount));
        assert_eq!(
            code(d.request(0, 1, 1, amount)),
            pay(PayError::InvalidAmount)
        );
    }
    assert_eq!(code(d.send(0, 1, 1, 101)), INSUFFICIENT_FUNDS);
    assert!(d.entry(0, 1).is_none());
    assert_eq!(d.balance(0), 100);
    assert_eq!((d.count(0), d.count(1)), (0, 0));
}

#[test]
fn self_payments_and_substituted_token_accounts_fail() {
    let mut d = Demo::new();
    assert_eq!(code(d.send(0, 0, 1, 1)), pay(PayError::InvalidParticipants));
    assert_eq!(
        code(d.request(0, 0, 1, 1)),
        pay(PayError::InvalidParticipants)
    );
    let mut instruction = d.send_ix(0, 1, 1, 5);
    instruction.accounts[8].pubkey = credits(d.key(2));
    assert_eq!(
        code(d.run(0, instruction)),
        anchor(ErrorCode::ConstraintTokenOwner)
    );
    assert_eq!(d.balance(2), 100);
    assert_eq!(d.count(0), 0);
}

#[test]
fn unregistered_participants_are_rejected() {
    let mut d = Demo::new();
    // NotRegistered: the profile account of the other participant does not exist.
    assert_eq!(code(d.send(0, 7, 1, 10)), not_initialized());
    assert_eq!(code(d.request(0, 7, 1, 10)), not_initialized());
    assert_eq!(code(d.send(7, 0, 1, 10)), not_initialized());
    assert_eq!(code(d.request(7, 0, 1, 10)), not_initialized());
    assert_eq!(d.count(0), 0);
    // The token itself still allows transfers to unregistered accounts.
    let outsider = credits(d.key(7));
    d.run(
        7,
        anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account(
            &d.key(7),
            &d.key(7),
            &mint(),
            &TOKEN_ID,
        ),
    )
    .unwrap();
    d.transfer(0, outsider, 5).unwrap();
    assert_eq!(d.read::<TokenAccount>(outsider).unwrap().amount, 5);
}

#[test]
fn another_signer_cannot_create_entries_for_the_owner() {
    let mut d = Demo::new();
    for mut instruction in [d.send_ix(0, 1, 1, 10), d.request_ix(0, 1, 1, 10)] {
        // An attacker cannot remove the required owner's signature from the account metas.
        instruction.accounts[0].is_signer = false;
        assert!(d.run(2, instruction).is_err());
    }
    assert_eq!(d.balance(0), 100);
    assert_eq!(d.count(0), 0);
    assert!(d.entry(0, 1).is_none());
}

#[test]
fn only_the_intended_payer_can_approve_or_decline() {
    let mut d = Demo::new();
    d.request(1, 0, 1, 20).unwrap();
    assert_eq!(code(d.approve(2, 1, 1)), pay(PayError::Unauthorized));
    assert_eq!(code(d.decline(2, 1, 1)), pay(PayError::Unauthorized));
    // The requester cannot resolve its own request either.
    assert_eq!(code(d.decline(1, 1, 1)), pay(PayError::Unauthorized));
    assert!(d.state(1, 1) == State::Pending);
    assert_eq!(d.balance(2), 100);
}

#[test]
fn paid_and_declined_are_final() {
    let mut d = Demo::new();
    d.request(1, 0, 1, 20).unwrap();
    d.approve(0, 1, 1).unwrap();
    assert_eq!(code(d.approve(0, 1, 1)), pay(PayError::NotPending));
    assert_eq!(code(d.decline(0, 1, 1)), pay(PayError::NotPending));
    assert!(d.state(1, 1) == State::Paid);
    assert_eq!(d.balance(0), 80);
    d.request(1, 0, 2, 30).unwrap();
    d.decline(0, 1, 2).unwrap();
    assert_eq!(code(d.approve(0, 1, 2)), pay(PayError::NotPending));
    assert!(d.state(1, 2) == State::Declined);
    assert_eq!(d.balance(0), 80);
    // A transfer is created Paid, so it cannot be approved again.
    d.send(1, 0, 3, 5).unwrap();
    assert_eq!(code(d.approve(0, 1, 3)), pay(PayError::NotPending));
    assert_eq!(code(d.decline(0, 1, 3)), pay(PayError::NotPending));
}

#[test]
fn missing_entries_are_not_found() {
    let mut d = Demo::new();
    assert!(d.entry(1, 9).is_none());
    assert_eq!(code(d.approve(0, 1, 9)), not_initialized());
    assert_eq!(code(d.decline(0, 1, 9)), not_initialized());
}

#[test]
fn insufficient_request_approval_stays_pending() {
    let mut d = Demo::new();
    d.request(1, 0, 1, 101).unwrap();
    assert_eq!(code(d.approve(0, 1, 1)), INSUFFICIENT_FUNDS);
    assert!(d.state(1, 1) == State::Pending);
    assert_eq!(d.balance(0), 100);
    d.decline(0, 1, 1).unwrap();
}

#[test]
fn decline_needs_no_token_accounts() {
    let mut d = Demo::new();
    d.request(1, 0, 1, 10).unwrap();
    // The payer empties and closes its token account. Decline still works.
    let to = credits(d.key(2));
    d.transfer(0, to, 100).unwrap();
    let close = spl_token::instruction::close_account(
        &TOKEN_ID,
        &credits(d.key(0)),
        &d.key(0),
        &d.key(0),
        &[],
    )
    .unwrap();
    d.run(0, close).unwrap();
    assert!(d.svm.get_account(&credits(d.key(0))).is_none());
    let instruction = d.decline_ix(0, 1, 1);
    assert_eq!(instruction.accounts.len(), 2);
    d.run(0, instruction).unwrap();
    assert!(d.state(1, 1) == State::Declined);
}

#[test]
fn distinct_requests_remain_distinct() {
    let mut d = Demo::new();
    d.request(0, 1, 1, 9).unwrap();
    d.request(0, 1, 2, 9).unwrap();
    assert_eq!(d.count(0), 2);
    assert_eq!(d.balance(0), 100);
    d.approve(1, 0, 1).unwrap();
    assert!(d.state(0, 2) == State::Pending);
    assert_eq!(d.balance(1), 91);
}

#[test]
fn external_token_transfer_changes_balance_without_app_activity() {
    let mut d = Demo::new();
    let to = credits(d.key(0));
    d.transfer(1, to, 3).unwrap();
    assert_eq!(d.balance(0), 103);
    assert_eq!(d.count(0), 0);
}

#[test]
fn users_cannot_mint_extra_credits() {
    let mut d = Demo::new();
    let unauthorized = spl_token::instruction::mint_to(
        &TOKEN_ID,
        &mint(),
        &credits(d.key(0)),
        &d.key(0),
        &[],
        100,
    )
    .unwrap();
    assert!(d.run(0, unauthorized).is_err());
    assert_eq!(d.balance(0), 100);
}

#[test]
fn activity_indexes_remain_ordered_across_the_page_boundary() {
    let mut d = Demo::new();
    for op in 1..=51 {
        d.request(0, 1, op, 1).unwrap();
    }
    d.approve(1, 0, 1).unwrap();
    assert_eq!(d.count(0), 51);
    let first = d.activity(0, 51, 50);
    let second = d.activity(0, 51 - first.len() as u64, 50);
    let all: Vec<_> = first.into_iter().chain(second).collect();
    let expected: Vec<_> = (1..=51).rev().map(|op| entry(d.key(0), op)).collect();
    assert_eq!(all, expected);
}

#[test]
fn absolute_activity_cursor_is_stable_when_a_record_lands_between_pages() {
    let mut d = Demo::new();
    for op in 1..=3 {
        d.send(0, 1, op, 1).unwrap();
    }
    let first = d.activity(0, d.count(0), 2);
    assert_eq!(first, [entry(d.key(0), 3), entry(d.key(0), 2)]);
    // A new record lands between the two reads.
    d.request(1, 0, 4, 1).unwrap();
    let second = d.activity(0, 3 - first.len() as u64, 2);
    assert_eq!(second, [entry(d.key(0), 1)]);
    // The new record is at the head of the next fresh read.
    assert_eq!(d.activity(0, d.count(0), 1), [entry(d.key(1), 4)]);
}

#[test]
fn initialize_creates_a_fixed_supply_mint_once() {
    let mut d = Demo::new();
    let demo_mint: anchor_spl::token::Mint = d.read(mint()).unwrap();
    assert_eq!(demo_mint.decimals, 0);
    assert_eq!(
        Option::<Pubkey>::from(demo_mint.mint_authority),
        Some(pda(&[b"authority"]))
    );
    assert!(Option::<Pubkey>::from(demo_mint.freeze_authority).is_none());
    assert_eq!(demo_mint.supply, 600);
    assert_eq!(code(d.run(1, d.initialize_ix(1))), ALREADY_IN_USE);
    assert_eq!(d.directory(), 6);
}

#[test]
fn approval_pays_only_the_requesters_token_account() {
    let mut d = Demo::new();
    d.request(1, 0, 1, 20).unwrap();
    let mut instruction = d.approve_ix(0, 1, 1);
    // `from_credits` must be the requester's associated token account.
    instruction.accounts[4].pubkey = credits(d.key(2));
    assert_eq!(
        code(d.run(0, instruction)),
        anchor(ErrorCode::ConstraintTokenOwner)
    );
    assert!(d.state(1, 1) == State::Pending);
    assert_eq!((d.balance(0), d.balance(2)), (100, 100));
}

#[test]
fn profiles_and_mints_cannot_be_substituted() {
    let mut d = Demo::new();
    let mut instruction = d.send_ix(0, 1, 1, 5);
    // Another user's profile in place of the sender's.
    instruction.accounts[1].pubkey = profile(d.key(2));
    assert_eq!(
        code(d.run(0, instruction)),
        anchor(ErrorCode::ConstraintSeeds)
    );
    // A mint that the sender controls, with its own token accounts.
    let fake = Keypair::new();
    // The packed size of an SPL Token mint.
    let space = 82;
    let rent = d.svm.minimum_balance_for_rent_exemption(space);
    let (owner, payee) = (d.key(0), d.key(1));
    let ata = |wallet: &Pubkey| {
        anchor_spl::associated_token::get_associated_token_address(wallet, &fake.pubkey())
    };
    let create_ata = |wallet: &Pubkey| {
        anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account(
            &owner,
            wallet,
            &fake.pubkey(),
            &TOKEN_ID,
        )
    };
    let setup = [
        anchor_lang::solana_program::system_instruction::create_account(
            &owner,
            &fake.pubkey(),
            rent,
            space as u64,
            &TOKEN_ID,
        ),
        spl_token::instruction::initialize_mint2(&TOKEN_ID, &fake.pubkey(), &owner, None, 0)
            .unwrap(),
        create_ata(&owner),
        create_ata(&payee),
        spl_token::instruction::mint_to(&TOKEN_ID, &fake.pubkey(), &ata(&owner), &owner, &[], 100)
            .unwrap(),
    ];
    d.run_signed(0, &setup, &[&fake]).unwrap();
    let mut instruction = d.send_ix(0, 1, 1, 5);
    instruction.accounts[6].pubkey = fake.pubkey();
    instruction.accounts[7].pubkey = ata(&owner);
    instruction.accounts[8].pubkey = ata(&payee);
    assert_eq!(
        code(d.run(0, instruction)),
        anchor(ErrorCode::ConstraintSeeds)
    );
    assert!(d.entry(0, 1).is_none());
    assert_eq!((d.balance(0), d.balance(1), d.count(0)), (100, 100, 0));
}

#[test]
fn payments_prepared_from_one_read_land_within_an_activity_page() {
    let mut d = Demo::new();
    // Two senders build payments to the same recipient from the same activity count.
    let first = d.send_ix(0, 2, 1, 5);
    let second = d.send_ix(1, 2, 1, 5);
    d.run(0, first).unwrap();
    d.run(1, second).unwrap();
    assert_eq!(d.count(2), 2);
    assert_eq!(
        d.activity(2, 2, 2),
        [entry(d.key(1), 1), entry(d.key(0), 1)]
    );
}

#[test]
fn a_stale_activity_page_fails_only_across_a_page_boundary() {
    let mut d = Demo::new();
    for op in 1..ACTIVITY_PAGE as u8 {
        d.request(0, 2, op, 1).unwrap();
    }
    let stale = d.send_ix(1, 2, 1, 5);
    // This record fills the recipient's first page, so the next one goes to the second page.
    d.request(3, 2, 1, 1).unwrap();
    assert_eq!(code(d.run(1, stale)), anchor(ErrorCode::ConstraintSeeds));
    assert_eq!(d.balance(1), 100);
    d.send(1, 2, 1, 5).unwrap();
    assert_eq!(d.count(2), ACTIVITY_PAGE + 1);
    assert_eq!(
        d.activity(2, ACTIVITY_PAGE + 1, 2),
        [entry(d.key(1), 1), entry(d.key(3), 1)]
    );
}

#[test]
fn instructions_stay_well_below_the_compute_limit() {
    // Regression bounds. PDA bump searches make the cost vary with each key: across 40
    // random keys, the most was about 65k units for register and 60k for send.
    let mut d = Demo::new();
    let used = [
        ("register", d.measure(6, d.register_ix(6)).unwrap(), 120_000),
        (
            "send",
            d.measure(0, d.send_ix(0, 1, 1, 5)).unwrap(),
            120_000,
        ),
        (
            "request",
            d.measure(1, d.request_ix(1, 0, 2, 5)).unwrap(),
            80_000,
        ),
        (
            "approve",
            d.measure(0, d.approve_ix(0, 1, 2)).unwrap(),
            60_000,
        ),
        (
            "request",
            d.measure(1, d.request_ix(1, 0, 3, 5)).unwrap(),
            80_000,
        ),
        (
            "decline",
            d.measure(0, d.decline_ix(0, 1, 3)).unwrap(),
            10_000,
        ),
    ];
    for (name, units, limit) in used {
        assert!(
            units < limit,
            "{name} used {units} of {limit} compute units"
        );
    }
}
