//! Bonded registry on Solana (docs/SPECIFICATION.md Section 7): agent records owned by their operator,
//! and scores posted as attestations signed by the attester key. Mirrors
//! `BondedRegistry` on EVM: the owner of an agent record is its operator, and a score is only
//! accepted with a valid attester signature over exactly its bytes.

use anchor_lang::prelude::*;
use bonded_ed25519::INSTRUCTIONS_SYSVAR_ID as INSTRUCTIONS_ID;

declare_id!("7hfPMrd4A264TfgTivV1QLmps9N5ZCf4r64csh8hfuYy");

/// Prefix of every signed attestation, so a signature for another purpose can't be replayed here.
pub const ATTESTATION_DOMAIN: &[u8] = b"bonded-attestation-v1";
pub const MAX_URI_LEN: usize = 200;

#[program]
pub mod bonded_registry {
    use super::*;

    /// One-time setup: the admin and the attester whose signatures are accepted.
    pub fn initialize(ctx: Context<Initialize>, attester: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.attester = attester;
        config.agent_count = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_attester(ctx: Context<AdminOnly>, attester: Pubkey) -> Result<()> {
        ctx.accounts.config.attester = attester;
        emit!(AttesterSet { attester });
        Ok(())
    }

    /// Register a new agent. The signer becomes its owner (the operator).
    pub fn register(ctx: Context<Register>, uri: String) -> Result<()> {
        require!(uri.len() <= MAX_URI_LEN, RegistryError::UriTooLong);
        let config = &mut ctx.accounts.config;
        config.agent_count = config
            .agent_count
            .checked_add(1)
            .ok_or(RegistryError::Overflow)?;
        let agent = &mut ctx.accounts.agent;
        agent.agent_id = config.agent_count;
        agent.owner = ctx.accounts.owner.key();
        agent.uri = uri;
        agent.score = None;
        agent.bump = ctx.bumps.agent;
        emit!(Registered {
            agent_id: agent.agent_id,
            owner: agent.owner
        });
        Ok(())
    }

    /// Post a score. The previous instruction in the transaction must be an Ed25519 signature
    /// check by the attester over `attestation_message(program id, attestation)`. Anyone can
    /// relay it. Versions must strictly increase, so an old score can't replace a newer one.
    pub fn post_score(ctx: Context<PostScore>, attestation: Attestation) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        require!(
            attestation.agent_id == agent.agent_id,
            RegistryError::WrongAgent
        );
        require!(attestation.score <= 100, RegistryError::InvalidScore);
        let now = Clock::get()?.unix_timestamp;
        require!(attestation.expires_at > now, RegistryError::Expired);
        require!(attestation.issued_at <= now, RegistryError::IssuedInFuture);
        if let Some(previous) = &agent.score {
            require!(
                attestation.issued_at > previous.issued_at,
                RegistryError::StaleScore
            );
        }
        let message = attestation_message(&crate::ID, &attestation);
        bonded_ed25519::require_signed(
            &ctx.accounts.instructions,
            &ctx.accounts.config.attester,
            &message,
        )?;
        emit!(ScorePosted {
            agent_id: agent.agent_id,
            score: attestation.score,
            report_hash: attestation.report_hash,
            issued_at: attestation.issued_at,
        });
        agent.score = Some(attestation);
        Ok(())
    }
}

/// The exact bytes the attester signs: a domain prefix, this program's id (so a signature for
/// another deployment can't be replayed) and the Borsh-encoded attestation.
pub fn attestation_message(program_id: &Pubkey, attestation: &Attestation) -> Vec<u8> {
    let mut message = Vec::with_capacity(ATTESTATION_DOMAIN.len() + 32 + 150);
    message.extend_from_slice(ATTESTATION_DOMAIN);
    message.extend_from_slice(program_id.as_ref());
    attestation.serialize(&mut message).expect("vec write");
    message
}

/// Same fields as the EVM `BondedTypes.Attestation`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace, Debug, PartialEq)]
pub struct Attestation {
    pub agent_id: u64,
    pub score: u16,
    pub expected_loss_bps: u32,
    pub report_hash: [u8; 32],
    pub mandate_hash: [u8; 32],
    pub code_hash: [u8; 32],
    pub tee_measurement: [u8; 32],
    pub model_family: u8,
    pub issued_at: i64,
    pub expires_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub attester: Pubkey,
    pub agent_count: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Agent {
    pub agent_id: u64,
    pub owner: Pubkey,
    #[max_len(MAX_URI_LEN)]
    pub uri: String,
    pub score: Option<Attestation>,
    pub bump: u8,
}

impl Agent {
    /// A current, unexpired score, as `BondedRegistry.hasValidScore`.
    pub fn valid_score(&self, now: i64) -> Option<&Attestation> {
        self.score.as_ref().filter(|s| s.expires_at > now)
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// This program, so its upgrade authority can be checked: only the deployer may configure it.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::BondedRegistry>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ RegistryError::NotDeployer)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct Register<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = owner,
        space = 8 + Agent::INIT_SPACE,
        seeds = [b"agent", (config.agent_count + 1).to_le_bytes().as_ref()],
        bump
    )]
    pub agent: Account<'info, Agent>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PostScore<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"agent", agent.agent_id.to_le_bytes().as_ref()], bump = agent.bump)]
    pub agent: Account<'info, Agent>,
    /// CHECK: the instructions sysvar, checked by address.
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[event]
pub struct Registered {
    pub agent_id: u64,
    pub owner: Pubkey,
}

#[event]
pub struct ScorePosted {
    pub agent_id: u64,
    pub score: u16,
    pub report_hash: [u8; 32],
    pub issued_at: i64,
}

#[event]
pub struct AttesterSet {
    pub attester: Pubkey,
}

#[error_code]
pub enum RegistryError {
    #[msg("agent URI is too long")]
    UriTooLong,
    #[msg("only the program's upgrade authority can initialize it")]
    NotDeployer,
    #[msg("the attestation is for a different agent")]
    WrongAgent,
    #[msg("score must be 0 to 100")]
    InvalidScore,
    #[msg("the attestation has expired")]
    Expired,
    #[msg("the attestation is issued in the future")]
    IssuedInFuture,
    #[msg("a newer score is already posted")]
    StaleScore,
    #[msg("arithmetic overflow")]
    Overflow,
}
