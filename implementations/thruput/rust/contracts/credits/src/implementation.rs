use thruput_erc20_if::*;
use thruput_erc20_metadata_if::{ERC20Metadata, Name, Symbol};
use thruput_sdk::block::get_block_height;
use thruput_sdk::storage::{Balance, Deletable, Map, NNInt, Node, Value};
use thruput_sdk::*;

#[thruput_sdk::storage]
#[derive(thruput_sdk::Deletable)]
#[cfg_attr(feature = "dev", derive(Debug))]
pub struct Allowance {
    amount: NNInt,
    expiry: Value<BlockHeight>,
}

#[contract_type]
#[cfg_attr(feature = "dev", derive(Debug))]
pub struct Config {
    pub administrator: ContractAddress,
    pub name: Option<Name>,
    pub symbol: Option<Symbol>,
    pub decimals: Option<u32>,
}

#[thruput_sdk::storage]
#[cfg_attr(feature = "dev", derive(Debug))]
pub struct Credits {
    config: Value<Config>,
    balances: Map<ContractAddress, Balance>,
    allowances: Map<ContractAddress, Map<ContractAddress, Node<Allowance>>>,
    total_supply: Balance,
}

impl Credits {
    fn init(&mut self, config: &Config) {
        ensure(
            self.config.try_get().none_if_missing().is_none(),
            ERC20Error::AlreadyInitialized,
        );
        self.config.set(config);
    }

    fn increase_balance(&mut self, owner: &ContractAddress, amount: Amount) {
        self.balances
            .at_mut(owner)
            .try_lazy_increase(amount)
            .unwrap_or_else(|_| throw(ERC20Error::TooLarge));
    }

    fn decrease_balance(&mut self, owner: &ContractAddress, amount: Amount) {
        self.balances
            .at_mut(owner)
            .try_decrease(amount)
            .unwrap_or_else(|_| throw(ERC20Error::TooLarge));
    }

    fn allowance_is_live(&self, owner: &ContractAddress, spender: &ContractAddress) -> bool {
        self.allowances
            .at(owner)
            .at(spender)
            .expiry
            .try_get()
            .none_if_missing()
            .is_none_or(|until| get_block_height() <= until)
    }

    /// The stored amount, whether or not it has expired.
    fn stored_allowance(&self, owner: &ContractAddress, spender: &ContractAddress) -> Amount {
        self.allowances
            .at(owner)
            .at(spender)
            .amount
            .try_get()
            .none_if_missing()
            .unwrap_or(0) as Amount
    }

    /// Delete the stored allowance under an exclusive lock and return the amount removed.
    fn remove_allowance(&mut self, owner: &ContractAddress, spender: &ContractAddress) -> Amount {
        let removed = self.stored_allowance(owner, spender);
        self.allowances
            .at_mut(owner)
            .at_mut(spender)
            .delete_exclusive();
        removed
    }
}

#[contract]
impl ERC20 for Credits {
    fn initialize(&mut self, administrator: &ContractAddress) {
        self.init(&Config {
            administrator: *administrator,
            name: None,
            symbol: None,
            decimals: None,
        });
    }

    fn transfer(&mut self, receiver: &ContractAddress, amount: Amount) {
        check_amount(amount);
        let owner = get_caller();
        self.decrease_balance(&owner, amount);
        self.increase_balance(receiver, amount);
        TransferEvent::new(&owner, receiver, amount).log();
    }

    fn transfer_from(
        &mut self,
        owner: &ContractAddress,
        receiver: &ContractAddress,
        amount: Amount,
    ) {
        let spender = get_caller();
        let amount = check_amount(amount);
        ensure(
            amount == 0 || self.allowance_is_live(owner, &spender),
            ERC20Error::TooLarge,
        );
        self.allowances
            .at_mut(owner)
            .at_mut(&spender)
            .amount
            .try_strict_inc(-amount)
            .unwrap_or_else(|_| throw(ERC20Error::TooLarge));
        self.decrease_balance(owner, amount);
        self.increase_balance(receiver, amount);
        TransferEvent::new(owner, receiver, amount).log();
    }

    fn adjust_allowance(&mut self, spender: &ContractAddress, difference: Difference) {
        let owner = get_caller();
        self.allowances
            .at_mut(&owner)
            .at_mut(spender)
            .amount
            .try_strict_inc(difference)
            .unwrap_or_else(|_| throw(ERC20Error::TooLarge));
        AllowanceChangeEvent::new(&owner, spender, difference).log();
    }

    fn delete_allowance(&mut self, spender: &ContractAddress) {
        let owner = get_caller();
        let removed = self.remove_allowance(&owner, spender);
        AllowanceDeleteEvent::new(&owner, spender, removed).log();
    }

    fn delete_balance(&mut self) {
        let mut balance = self.balances.at_mut(&get_caller());
        ensure(balance.get() == 0, ERC20Error::BalanceNotZero);
        balance.delete_exclusive();
    }

    fn allowance(&self, owner: &ContractAddress, spender: &ContractAddress) -> Amount {
        if self.allowance_is_live(owner, spender) {
            self.stored_allowance(owner, spender)
        } else {
            0
        }
    }

    fn get_balance_of(&self, owner: &ContractAddress) -> Amount {
        self.balances.at(owner).get()
    }

    fn get_balance(&self) -> Amount {
        self.balances.at(&get_caller()).get()
    }

    fn mint(&mut self, receiver: &ContractAddress, amount: Amount) {
        check_amount(amount);
        ensure(
            get_caller() == self.config.get().administrator,
            ERC20Error::MustBeContractOwner,
        );
        // The checked supply bound makes the lazy balance increase safe.
        self.total_supply
            .try_increase(amount)
            .unwrap_or_else(|_| throw(ERC20Error::TooLarge));
        self.increase_balance(receiver, amount);
        MintEvent::new(receiver, amount).log();
    }

    fn total_supply(&self) -> Amount {
        self.total_supply.get()
    }
}

#[contract]
impl ERC20AllowanceExpiry for Credits {
    fn reset_allowance(&mut self, spender: &ContractAddress, until: BlockHeight) {
        let owner = get_caller();
        // The delete's exclusive lock covers the expiry write.
        let removed = self.remove_allowance(&owner, spender);
        self.allowances
            .at_mut(&owner)
            .at_mut(spender)
            .expiry
            .set(&until);
        AllowanceResetEvent::new(&owner, spender, removed, until).log();
    }
}

#[contract]
impl ERC20Metadata for Credits {
    fn initialize(
        &mut self,
        administrator: &ContractAddress,
        name: Option<Name>,
        symbol: Option<Symbol>,
        decimals: Option<u32>,
    ) {
        self.init(&Config {
            administrator: *administrator,
            name,
            symbol,
            decimals,
        });
    }

    fn name(&self) -> Option<Name> {
        self.config.get().name
    }

    fn symbol(&self) -> Option<Symbol> {
        self.config.get().symbol
    }

    fn decimals(&self) -> Option<u32> {
        self.config.get().decimals
    }
}
