use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, MintTo, Token, TokenAccount, TransferChecked},
};

pub mod state;
use state::*;

declare_id!("Wn8Ma9d5nMPhZhqUCXKSJMJMSNGZ8bunifjkD84rA64");

#[program]
pub mod paymvc {
    use super::*;

    /// Create the directory and the demo mint. No caller receives mint authority.
    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }

    /// The caller registers itself: one profile, one directory member, and 100 credits.
    pub fn register(ctx: Context<Register>) -> Result<()> {
        let accounts = ctx.accounts;
        accounts.profile.set_inner(Profile {
            owner: accounts.owner.key(),
            activity_count: 0,
        });
        accounts.member.owner = accounts.owner.key();
        accounts.directory.count += 1;
        let seeds: &[&[u8]] = &[b"authority", &[ctx.bumps.authority]];
        token::mint_to(
            CpiContext::new_with_signer(
                accounts.token_program.key(),
                MintTo {
                    mint: accounts.mint.to_account_info(),
                    to: accounts.credits.to_account_info(),
                    authority: accounts.authority.to_account_info(),
                },
                &[seeds],
            ),
            100,
        )
    }

    /// The caller pays `to`. The entry is created Paid, and the tokens move in the same instruction.
    pub fn send(ctx: Context<Send>, to: Pubkey, amount: u64, operation: [u8; 32]) -> Result<()> {
        validate(amount, operation)?;
        let accounts = ctx.accounts;
        token::transfer_checked(
            CpiContext::new(
                accounts.token_program.key(),
                TransferChecked {
                    from: accounts.from_credits.to_account_info(),
                    to: accounts.to_credits.to_account_info(),
                    mint: accounts.mint.to_account_info(),
                    authority: accounts.from.to_account_info(),
                },
            ),
            amount,
            0,
        )?;
        accounts.entry.set_inner(Entry {
            from: accounts.from.key(),
            to,
            operation,
            amount,
            kind: Kind::Transfer,
            state: State::Paid,
        });
        let entry = accounts.entry.key();
        add_activity(
            entry,
            &mut accounts.from_profile,
            &mut accounts.from_activity,
        );
        add_activity(entry, &mut accounts.to_profile, &mut accounts.to_activity);
        Ok(())
    }

    /// The caller asks `payer` for credits. The entry is created Pending and reserves no funds.
    pub fn request(
        ctx: Context<Request>,
        payer: Pubkey,
        amount: u64,
        operation: [u8; 32],
    ) -> Result<()> {
        validate(amount, operation)?;
        let accounts = ctx.accounts;
        accounts.entry.set_inner(Entry {
            from: accounts.from.key(),
            to: payer,
            operation,
            amount,
            kind: Kind::Request,
            state: State::Pending,
        });
        let entry = accounts.entry.key();
        add_activity(
            entry,
            &mut accounts.from_profile,
            &mut accounts.from_activity,
        );
        add_activity(
            entry,
            &mut accounts.payer_profile,
            &mut accounts.payer_activity,
        );
        Ok(())
    }

    /// The intended payer pays a Pending request. If the transfer fails, the request stays Pending.
    /// `from` and `operation` only locate the entry; the account constraints use them.
    #[allow(unused_variables)]
    pub fn approve(ctx: Context<Approve>, from: Pubkey, operation: [u8; 32]) -> Result<()> {
        let accounts = ctx.accounts;
        token::transfer_checked(
            CpiContext::new(
                accounts.token_program.key(),
                TransferChecked {
                    from: accounts.payer_credits.to_account_info(),
                    to: accounts.from_credits.to_account_info(),
                    mint: accounts.mint.to_account_info(),
                    authority: accounts.payer.to_account_info(),
                },
            ),
            accounts.entry.amount,
            0,
        )?;
        accounts.entry.state = State::Paid;
        Ok(())
    }

    /// The intended payer declines a Pending request. No funds move.
    #[allow(unused_variables)]
    pub fn decline(ctx: Context<Decline>, from: Pubkey, operation: [u8; 32]) -> Result<()> {
        ctx.accounts.entry.state = State::Declined;
        Ok(())
    }
}

fn validate(amount: u64, operation: [u8; 32]) -> Result<()> {
    require!(operation != [0; 32], PayError::InvalidOperation);
    require!((1..=1_000_000).contains(&amount), PayError::InvalidAmount);
    Ok(())
}

/// Append the entry to one participant's numbered activity list.
fn add_activity(entry: Pubkey, profile: &mut Profile, activity: &mut Activity) {
    activity.entry = entry;
    profile.activity_count += 1;
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Directory::INIT_SPACE, seeds = [b"directory"], bump)]
    pub directory: Account<'info, Directory>,
    #[account(init, payer = payer, seeds = [b"mint"], bump, mint::decimals = 0, mint::authority = authority)]
    pub mint: Account<'info, Mint>,
    /// CHECK: PDA is only used as the mint authority; it stores no data.
    #[account(seeds = [b"authority"], bump)]
    pub authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Register<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// `init` fails if the profile exists, so registration cannot repeat.
    #[account(init, payer = owner, space = 8 + Profile::INIT_SPACE, seeds = [b"profile", owner.key().as_ref()], bump)]
    pub profile: Account<'info, Profile>,
    #[account(mut, seeds = [b"directory"], bump)]
    pub directory: Account<'info, Directory>,
    #[account(init, payer = owner, space = 8 + Member::INIT_SPACE, seeds = [b"member".as_ref(), &directory.count.to_le_bytes()], bump)]
    pub member: Account<'info, Member>,
    #[account(mut, seeds = [b"mint"], bump)]
    pub mint: Account<'info, Mint>,
    /// CHECK: Seeds constrain the mint authority.
    #[account(seeds = [b"authority"], bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = owner, associated_token::mint = mint, associated_token::authority = owner)]
    pub credits: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(to: Pubkey, amount: u64, operation: [u8; 32])]
pub struct Send<'info> {
    #[account(mut)]
    pub from: Signer<'info>,
    /// The profile seeds prove that both participants are registered.
    #[account(mut, seeds = [b"profile", from.key().as_ref()], bump)]
    pub from_profile: Account<'info, Profile>,
    #[account(mut, seeds = [b"profile", to.as_ref()], bump)]
    pub to_profile: Account<'info, Profile>,
    /// `init` fails if `(from, operation)` was used. The participant check runs here,
    /// before the activity accounts are created, so a self-payment fails with InvalidParticipants.
    #[account(
        init, payer = from, space = 8 + Entry::INIT_SPACE,
        seeds = [b"entry", from.key().as_ref(), &operation], bump,
        constraint = to != from.key() @ PayError::InvalidParticipants,
    )]
    pub entry: Account<'info, Entry>,
    #[account(init, payer = from, space = 8 + Activity::INIT_SPACE, seeds = [b"activity", from.key().as_ref(), &from_profile.activity_count.to_le_bytes()], bump)]
    pub from_activity: Account<'info, Activity>,
    #[account(init, payer = from, space = 8 + Activity::INIT_SPACE, seeds = [b"activity", to.as_ref(), &to_profile.activity_count.to_le_bytes()], bump)]
    pub to_activity: Account<'info, Activity>,
    #[account(seeds = [b"mint"], bump)]
    pub mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = from)]
    pub from_credits: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = to)]
    pub to_credits: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(payer: Pubkey, amount: u64, operation: [u8; 32])]
pub struct Request<'info> {
    #[account(mut)]
    pub from: Signer<'info>,
    #[account(mut, seeds = [b"profile", from.key().as_ref()], bump)]
    pub from_profile: Account<'info, Profile>,
    #[account(mut, seeds = [b"profile", payer.as_ref()], bump)]
    pub payer_profile: Account<'info, Profile>,
    #[account(
        init, payer = from, space = 8 + Entry::INIT_SPACE,
        seeds = [b"entry", from.key().as_ref(), &operation], bump,
        constraint = payer != from.key() @ PayError::InvalidParticipants,
    )]
    pub entry: Account<'info, Entry>,
    #[account(init, payer = from, space = 8 + Activity::INIT_SPACE, seeds = [b"activity", from.key().as_ref(), &from_profile.activity_count.to_le_bytes()], bump)]
    pub from_activity: Account<'info, Activity>,
    #[account(init, payer = from, space = 8 + Activity::INIT_SPACE, seeds = [b"activity", payer.as_ref(), &payer_profile.activity_count.to_le_bytes()], bump)]
    pub payer_activity: Account<'info, Activity>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(from: Pubkey, operation: [u8; 32])]
pub struct Approve<'info> {
    pub payer: Signer<'info>,
    #[account(
        mut, seeds = [b"entry", from.as_ref(), &operation], bump,
        constraint = entry.to == payer.key() @ PayError::Unauthorized,
        constraint = entry.state == State::Pending @ PayError::NotPending,
    )]
    pub entry: Account<'info, Entry>,
    #[account(seeds = [b"mint"], bump)]
    pub mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = payer)]
    pub payer_credits: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = from)]
    pub from_credits: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Decline needs only the payer and the entry. It never touches token accounts.
#[derive(Accounts)]
#[instruction(from: Pubkey, operation: [u8; 32])]
pub struct Decline<'info> {
    pub payer: Signer<'info>,
    #[account(
        mut, seeds = [b"entry", from.as_ref(), &operation], bump,
        constraint = entry.to == payer.key() @ PayError::Unauthorized,
        constraint = entry.state == State::Pending @ PayError::NotPending,
    )]
    pub entry: Account<'info, Entry>,
}

/// Errors that this program raises. The account runtime raises the others natively:
/// AlreadyRegistered and OperationUsed are `init` on an existing account, and
/// NotRegistered and NotFound are a missing profile or entry account.
#[error_code]
pub enum PayError {
    #[msg("Choose a different registered account.")]
    InvalidParticipants,
    #[msg("Use a whole amount from 1 to 1,000,000.")]
    InvalidAmount,
    #[msg("Use a nonzero operation ID.")]
    InvalidOperation,
    #[msg("Only the intended payer can approve or decline this request.")]
    Unauthorized,
    #[msg("This request is not pending.")]
    NotPending,
}
