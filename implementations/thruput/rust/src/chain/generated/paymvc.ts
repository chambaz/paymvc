// Generated from paymvc.spec.xdr - PayMVC interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import * as __gh_protocol from "@thruputchain/protocol";
import * as __gh_protocol_utils from "@thruputchain/protocol/utils";
import * as __gh_contract_spec from "@thruputchain/contract-spec";
import * as __gh_client_contract from "@thruputchain/client/contract";

const __gh_s = __gh_contract_spec.contractSpecString;

const __gh_entrypoints = {
  PayMVC: {
    v0_1: {
      activity: __gh_protocol.contractEntrypointID(__gh_protocol_utils.fromHex("89c7d17e6da07252")),
      activityCount: __gh_protocol.contractEntrypointID(__gh_protocol_utils.fromHex("aca2e142ae69d6d7")),
      approve: __gh_protocol.contractEntrypointID(__gh_protocol_utils.fromHex("cb6ffdf6a7c2019b")),
      credits: __gh_protocol.contractEntrypointID(__gh_protocol_utils.fromHex("3b93a3402561b0a8")),
      decline: __gh_protocol.contractEntrypointID(__gh_protocol_utils.fromHex("22b334d8771ae634")),
      entry: __gh_protocol.contractEntrypointID(__gh_protocol_utils.fromHex("c2ac3689d24d6f2d")),
      initialize: __gh_protocol.contractEntrypointID(__gh_protocol_utils.fromHex("dcf5acd080385c27")),
      profileCount: __gh_protocol.contractEntrypointID(__gh_protocol_utils.fromHex("8325047bb7c99c70")),
      profiles: __gh_protocol.contractEntrypointID(__gh_protocol_utils.fromHex("f1a5855d26fccefb")),
      register: __gh_protocol.contractEntrypointID(__gh_protocol_utils.fromHex("fc7b3b0dc1181f7b")),
      registered: __gh_protocol.contractEntrypointID(__gh_protocol_utils.fromHex("68b73f0f65b9e252")),
      request: __gh_protocol.contractEntrypointID(__gh_protocol_utils.fromHex("283bbb30f2af6e57")),
      send: __gh_protocol.contractEntrypointID(__gh_protocol_utils.fromHex("42ae6754f3faf8dd")),
    },
  },
} as const;

export namespace paymvc {

  export namespace v0_1 {

    export namespace implementation {

      export interface Entry { "from": __gh_protocol.ContractAddress; "to": __gh_protocol.ContractAddress; "operation": __gh_client_contract.FixedBytes<32>; "amount": bigint; "kind": __gh_codegen.paymvc$v0_1$implementation$Kind; "state": __gh_codegen.paymvc$v0_1$implementation$State; }

      export type Kind = 0n | 1n;

      export type PaymentError = 1n | 2n | 3n | 4n | 5n | 6n | 7n | 8n | 9n | 10n;

      export type State = 0n | 1n | 2n;
    }
  }
}

export namespace PayMVC {

  export namespace v0_1 {

    export interface ActivityArgs {
      account: __gh_protocol.ContractAddress;
      before: bigint;
      limit: bigint;
    }
    export type ActivityResult = __gh_codegen.paymvc$v0_1$implementation$Entry[];

    export interface ActivityCountArgs {
      account: __gh_protocol.ContractAddress;
    }
    export type ActivityCountResult = bigint;

    export interface ApproveArgs {
      from: __gh_protocol.ContractAddress;
      operation: __gh_client_contract.FixedBytes<32>;
    }
    export type ApproveResult = void;

    export type CreditsArgs = void;
    export type CreditsResult = __gh_protocol.ContractAddress;

    export interface DeclineArgs {
      from: __gh_protocol.ContractAddress;
      operation: __gh_client_contract.FixedBytes<32>;
    }
    export type DeclineResult = void;

    export interface EntryArgs {
      from: __gh_protocol.ContractAddress;
      operation: __gh_client_contract.FixedBytes<32>;
    }
    export type EntryResult = __gh_codegen.paymvc$v0_1$implementation$Entry | null;

    export interface InitializeArgs {
      credits: __gh_protocol.ContractAddress;
    }
    export type InitializeResult = void;

    export type ProfileCountArgs = void;
    export type ProfileCountResult = bigint;

    export interface ProfilesArgs {
      start: bigint;
      limit: bigint;
    }
    export type ProfilesResult = __gh_protocol.ContractAddress[];

    export type RegisterArgs = void;
    export type RegisterResult = void;

    export interface RegisteredArgs {
      account: __gh_protocol.ContractAddress;
    }
    export type RegisteredResult = boolean;

    export interface RequestArgs {
      payer: __gh_protocol.ContractAddress;
      amount: bigint;
      operation: __gh_client_contract.FixedBytes<32>;
    }
    export type RequestResult = void;

    export interface SendArgs {
      to: __gh_protocol.ContractAddress;
      amount: bigint;
      operation: __gh_client_contract.FixedBytes<32>;
    }
    export type SendResult = void;

    export type DeclaredException =
      {
        kind: "declared";
        name: "PaymentError";
        selector: 0x960e1141659f0779n;
        value: __gh_codegen.paymvc$v0_1$implementation$PaymentError;
      };
    export type Exception = __gh_client_contract.ContractException<DeclaredException>;
  }
}

export const spec: __gh_client_contract.ContractSpec = {
  interfaces: [
    {
      name: __gh_s("PayMVC"),
      vers: __gh_s("0.1.0"),
      throws: [
        { selector: 0x960e1141659f0779n, ty: { v: __gh_contract_spec.ContractTypeKind.Named, named: { crate_name: __gh_s("paymvc"), major: __gh_s("0.1"), module_path: __gh_s("paymvc::implementation"), declared: __gh_s("PaymentError") } } },
      ],
      methods: [
        {
          name: __gh_s("activity"),
          args: [
            { name: __gh_s("account"), ty: { v: __gh_contract_spec.ContractTypeKind.Address } },
            { name: __gh_s("before"), ty: { v: __gh_contract_spec.ContractTypeKind.U64 } },
            { name: __gh_s("limit"), ty: { v: __gh_contract_spec.ContractTypeKind.U64 } },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Vector, vector: { element: { v: __gh_contract_spec.ContractTypeKind.Named, named: { crate_name: __gh_s("paymvc"), major: __gh_s("0.1"), module_path: __gh_s("paymvc::implementation"), declared: __gh_s("Entry") } }, max_len: 4294967295n } },
          effect: __gh_client_contract.ContractMethodEffect.EffectReadOnly,
        },
        {
          name: __gh_s("activity_count"),
          args: [
            { name: __gh_s("account"), ty: { v: __gh_contract_spec.ContractTypeKind.Address } },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.U64 },
          effect: __gh_client_contract.ContractMethodEffect.EffectReadOnly,
        },
        {
          name: __gh_s("approve"),
          args: [
            { name: __gh_s("from"), ty: { v: __gh_contract_spec.ContractTypeKind.Address } },
            { name: __gh_s("operation"), ty: { v: __gh_contract_spec.ContractTypeKind.Array, array: { element: { v: __gh_contract_spec.ContractTypeKind.U8 }, len: 32n } } },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("credits"),
          args: [
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Address },
          effect: __gh_client_contract.ContractMethodEffect.EffectReadOnly,
        },
        {
          name: __gh_s("decline"),
          args: [
            { name: __gh_s("from"), ty: { v: __gh_contract_spec.ContractTypeKind.Address } },
            { name: __gh_s("operation"), ty: { v: __gh_contract_spec.ContractTypeKind.Array, array: { element: { v: __gh_contract_spec.ContractTypeKind.U8 }, len: 32n } } },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("entry"),
          args: [
            { name: __gh_s("from"), ty: { v: __gh_contract_spec.ContractTypeKind.Address } },
            { name: __gh_s("operation"), ty: { v: __gh_contract_spec.ContractTypeKind.Array, array: { element: { v: __gh_contract_spec.ContractTypeKind.U8 }, len: 32n } } },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Option, option_inner: { v: __gh_contract_spec.ContractTypeKind.Named, named: { crate_name: __gh_s("paymvc"), major: __gh_s("0.1"), module_path: __gh_s("paymvc::implementation"), declared: __gh_s("Entry") } } },
          effect: __gh_client_contract.ContractMethodEffect.EffectReadOnly,
        },
        {
          name: __gh_s("initialize"),
          args: [
            { name: __gh_s("credits"), ty: { v: __gh_contract_spec.ContractTypeKind.Address } },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("profile_count"),
          args: [
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.U64 },
          effect: __gh_client_contract.ContractMethodEffect.EffectReadOnly,
        },
        {
          name: __gh_s("profiles"),
          args: [
            { name: __gh_s("start"), ty: { v: __gh_contract_spec.ContractTypeKind.U64 } },
            { name: __gh_s("limit"), ty: { v: __gh_contract_spec.ContractTypeKind.U64 } },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Vector, vector: { element: { v: __gh_contract_spec.ContractTypeKind.Address }, max_len: 4294967295n } },
          effect: __gh_client_contract.ContractMethodEffect.EffectReadOnly,
        },
        {
          name: __gh_s("register"),
          args: [
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("registered"),
          args: [
            { name: __gh_s("account"), ty: { v: __gh_contract_spec.ContractTypeKind.Address } },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Bool },
          effect: __gh_client_contract.ContractMethodEffect.EffectReadOnly,
        },
        {
          name: __gh_s("request"),
          args: [
            { name: __gh_s("payer"), ty: { v: __gh_contract_spec.ContractTypeKind.Address } },
            { name: __gh_s("amount"), ty: { v: __gh_contract_spec.ContractTypeKind.I128 } },
            { name: __gh_s("operation"), ty: { v: __gh_contract_spec.ContractTypeKind.Array, array: { element: { v: __gh_contract_spec.ContractTypeKind.U8 }, len: 32n } } },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
        {
          name: __gh_s("send"),
          args: [
            { name: __gh_s("to"), ty: { v: __gh_contract_spec.ContractTypeKind.Address } },
            { name: __gh_s("amount"), ty: { v: __gh_contract_spec.ContractTypeKind.I128 } },
            { name: __gh_s("operation"), ty: { v: __gh_contract_spec.ContractTypeKind.Array, array: { element: { v: __gh_contract_spec.ContractTypeKind.U8 }, len: 32n } } },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Void },
          effect: null,
        },
      ],
    },
  ],
  type_defs: [
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: { crate_name: __gh_s("paymvc"), major: __gh_s("0.1"), module_path: __gh_s("paymvc::implementation"), declared: __gh_s("Entry") },
        fields: [
          { name: __gh_s("from"), ty: { v: __gh_contract_spec.ContractTypeKind.Address } },
          { name: __gh_s("to"), ty: { v: __gh_contract_spec.ContractTypeKind.Address } },
          { name: __gh_s("operation"), ty: { v: __gh_contract_spec.ContractTypeKind.Array, array: { element: { v: __gh_contract_spec.ContractTypeKind.U8 }, len: 32n } } },
          { name: __gh_s("amount"), ty: { v: __gh_contract_spec.ContractTypeKind.I128 } },
          { name: __gh_s("kind"), ty: { v: __gh_contract_spec.ContractTypeKind.Named, named: { crate_name: __gh_s("paymvc"), major: __gh_s("0.1"), module_path: __gh_s("paymvc::implementation"), declared: __gh_s("Kind") } } },
          { name: __gh_s("state"), ty: { v: __gh_contract_spec.ContractTypeKind.Named, named: { crate_name: __gh_s("paymvc"), major: __gh_s("0.1"), module_path: __gh_s("paymvc::implementation"), declared: __gh_s("State") } } },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: { crate_name: __gh_s("paymvc"), major: __gh_s("0.1"), module_path: __gh_s("paymvc::implementation"), declared: __gh_s("Kind") },
        variants: [
          { name: __gh_s("Transfer"), value: 0n },
          { name: __gh_s("Request"), value: 1n },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: { crate_name: __gh_s("paymvc"), major: __gh_s("0.1"), module_path: __gh_s("paymvc::implementation"), declared: __gh_s("PaymentError") },
        variants: [
          { name: __gh_s("AlreadyRegistered"), value: 1n },
          { name: __gh_s("NotRegistered"), value: 2n },
          { name: __gh_s("InvalidParticipants"), value: 3n },
          { name: __gh_s("InvalidAmount"), value: 4n },
          { name: __gh_s("InvalidOperation"), value: 5n },
          { name: __gh_s("OperationUsed"), value: 6n },
          { name: __gh_s("NotFound"), value: 7n },
          { name: __gh_s("Unauthorized"), value: 8n },
          { name: __gh_s("NotPending"), value: 9n },
          { name: __gh_s("InvalidPage"), value: 10n },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: { crate_name: __gh_s("paymvc"), major: __gh_s("0.1"), module_path: __gh_s("paymvc::implementation"), declared: __gh_s("State") },
        variants: [
          { name: __gh_s("Pending"), value: 0n },
          { name: __gh_s("Paid"), value: 1n },
          { name: __gh_s("Declined"), value: 2n },
        ],
      },
    },
  ],
  events: [
  ],
};

const __gh_codecs = __gh_client_contract.createContractCodecContext(spec.type_defs);

export const PayMVC = {
  v0_1: {
    /** Declared effect: readOnly. Author declaration; not compiler/runtime enforced. */
    activity: __gh_client_contract.defineContractMethod<
      PayMVC.v0_1.ActivityArgs,
      PayMVC.v0_1.ActivityResult,
      PayMVC.v0_1.DeclaredException
    >({
      interfaceName: "PayMVC",
      interfaceVersion: "0.1.0",
      abiName: "activity",
      publicName: "activity",
      entrypoint: __gh_entrypoints.PayMVC.v0_1.activity,
      effect: spec.interfaces[0]!.methods[0]!.effect,
      args: [
        {
          abiName: "account",
          publicName: "account",
          type: spec.interfaces[0]!.methods[0]!.args[0]!.ty,
        },
        {
          abiName: "before",
          publicName: "before",
          type: spec.interfaces[0]!.methods[0]!.args[1]!.ty,
        },
        {
          abiName: "limit",
          publicName: "limit",
          type: spec.interfaces[0]!.methods[0]!.args[2]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[0]!.return_type,
      throws: [
        {
          selector: 0x960e1141659f0779n,
          name: "PaymentError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    /** Declared effect: readOnly. Author declaration; not compiler/runtime enforced. */
    activityCount: __gh_client_contract.defineContractMethod<
      PayMVC.v0_1.ActivityCountArgs,
      PayMVC.v0_1.ActivityCountResult,
      PayMVC.v0_1.DeclaredException
    >({
      interfaceName: "PayMVC",
      interfaceVersion: "0.1.0",
      abiName: "activity_count",
      publicName: "activityCount",
      entrypoint: __gh_entrypoints.PayMVC.v0_1.activityCount,
      effect: spec.interfaces[0]!.methods[1]!.effect,
      args: [
        {
          abiName: "account",
          publicName: "account",
          type: spec.interfaces[0]!.methods[1]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[1]!.return_type,
      throws: [
        {
          selector: 0x960e1141659f0779n,
          name: "PaymentError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    approve: __gh_client_contract.defineContractMethod<
      PayMVC.v0_1.ApproveArgs,
      PayMVC.v0_1.ApproveResult,
      PayMVC.v0_1.DeclaredException
    >({
      interfaceName: "PayMVC",
      interfaceVersion: "0.1.0",
      abiName: "approve",
      publicName: "approve",
      entrypoint: __gh_entrypoints.PayMVC.v0_1.approve,
      effect: spec.interfaces[0]!.methods[2]!.effect,
      args: [
        {
          abiName: "from",
          publicName: "from",
          type: spec.interfaces[0]!.methods[2]!.args[0]!.ty,
        },
        {
          abiName: "operation",
          publicName: "operation",
          type: spec.interfaces[0]!.methods[2]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[2]!.return_type,
      throws: [
        {
          selector: 0x960e1141659f0779n,
          name: "PaymentError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    /** Declared effect: readOnly. Author declaration; not compiler/runtime enforced. */
    credits: __gh_client_contract.defineContractMethod<
      PayMVC.v0_1.CreditsArgs,
      PayMVC.v0_1.CreditsResult,
      PayMVC.v0_1.DeclaredException
    >({
      interfaceName: "PayMVC",
      interfaceVersion: "0.1.0",
      abiName: "credits",
      publicName: "credits",
      entrypoint: __gh_entrypoints.PayMVC.v0_1.credits,
      effect: spec.interfaces[0]!.methods[3]!.effect,
      args: [
      ],
      returnType: spec.interfaces[0]!.methods[3]!.return_type,
      throws: [
        {
          selector: 0x960e1141659f0779n,
          name: "PaymentError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    decline: __gh_client_contract.defineContractMethod<
      PayMVC.v0_1.DeclineArgs,
      PayMVC.v0_1.DeclineResult,
      PayMVC.v0_1.DeclaredException
    >({
      interfaceName: "PayMVC",
      interfaceVersion: "0.1.0",
      abiName: "decline",
      publicName: "decline",
      entrypoint: __gh_entrypoints.PayMVC.v0_1.decline,
      effect: spec.interfaces[0]!.methods[4]!.effect,
      args: [
        {
          abiName: "from",
          publicName: "from",
          type: spec.interfaces[0]!.methods[4]!.args[0]!.ty,
        },
        {
          abiName: "operation",
          publicName: "operation",
          type: spec.interfaces[0]!.methods[4]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[4]!.return_type,
      throws: [
        {
          selector: 0x960e1141659f0779n,
          name: "PaymentError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    /** Declared effect: readOnly. Author declaration; not compiler/runtime enforced. */
    entry: __gh_client_contract.defineContractMethod<
      PayMVC.v0_1.EntryArgs,
      PayMVC.v0_1.EntryResult,
      PayMVC.v0_1.DeclaredException
    >({
      interfaceName: "PayMVC",
      interfaceVersion: "0.1.0",
      abiName: "entry",
      publicName: "entry",
      entrypoint: __gh_entrypoints.PayMVC.v0_1.entry,
      effect: spec.interfaces[0]!.methods[5]!.effect,
      args: [
        {
          abiName: "from",
          publicName: "from",
          type: spec.interfaces[0]!.methods[5]!.args[0]!.ty,
        },
        {
          abiName: "operation",
          publicName: "operation",
          type: spec.interfaces[0]!.methods[5]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[5]!.return_type,
      throws: [
        {
          selector: 0x960e1141659f0779n,
          name: "PaymentError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    initialize: __gh_client_contract.defineContractMethod<
      PayMVC.v0_1.InitializeArgs,
      PayMVC.v0_1.InitializeResult,
      PayMVC.v0_1.DeclaredException
    >({
      interfaceName: "PayMVC",
      interfaceVersion: "0.1.0",
      abiName: "initialize",
      publicName: "initialize",
      entrypoint: __gh_entrypoints.PayMVC.v0_1.initialize,
      effect: spec.interfaces[0]!.methods[6]!.effect,
      args: [
        {
          abiName: "credits",
          publicName: "credits",
          type: spec.interfaces[0]!.methods[6]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[6]!.return_type,
      throws: [
        {
          selector: 0x960e1141659f0779n,
          name: "PaymentError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    /** Declared effect: readOnly. Author declaration; not compiler/runtime enforced. */
    profileCount: __gh_client_contract.defineContractMethod<
      PayMVC.v0_1.ProfileCountArgs,
      PayMVC.v0_1.ProfileCountResult,
      PayMVC.v0_1.DeclaredException
    >({
      interfaceName: "PayMVC",
      interfaceVersion: "0.1.0",
      abiName: "profile_count",
      publicName: "profileCount",
      entrypoint: __gh_entrypoints.PayMVC.v0_1.profileCount,
      effect: spec.interfaces[0]!.methods[7]!.effect,
      args: [
      ],
      returnType: spec.interfaces[0]!.methods[7]!.return_type,
      throws: [
        {
          selector: 0x960e1141659f0779n,
          name: "PaymentError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    /** Declared effect: readOnly. Author declaration; not compiler/runtime enforced. */
    profiles: __gh_client_contract.defineContractMethod<
      PayMVC.v0_1.ProfilesArgs,
      PayMVC.v0_1.ProfilesResult,
      PayMVC.v0_1.DeclaredException
    >({
      interfaceName: "PayMVC",
      interfaceVersion: "0.1.0",
      abiName: "profiles",
      publicName: "profiles",
      entrypoint: __gh_entrypoints.PayMVC.v0_1.profiles,
      effect: spec.interfaces[0]!.methods[8]!.effect,
      args: [
        {
          abiName: "start",
          publicName: "start",
          type: spec.interfaces[0]!.methods[8]!.args[0]!.ty,
        },
        {
          abiName: "limit",
          publicName: "limit",
          type: spec.interfaces[0]!.methods[8]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[8]!.return_type,
      throws: [
        {
          selector: 0x960e1141659f0779n,
          name: "PaymentError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    register: __gh_client_contract.defineContractMethod<
      PayMVC.v0_1.RegisterArgs,
      PayMVC.v0_1.RegisterResult,
      PayMVC.v0_1.DeclaredException
    >({
      interfaceName: "PayMVC",
      interfaceVersion: "0.1.0",
      abiName: "register",
      publicName: "register",
      entrypoint: __gh_entrypoints.PayMVC.v0_1.register,
      effect: spec.interfaces[0]!.methods[9]!.effect,
      args: [
      ],
      returnType: spec.interfaces[0]!.methods[9]!.return_type,
      throws: [
        {
          selector: 0x960e1141659f0779n,
          name: "PaymentError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    /** Declared effect: readOnly. Author declaration; not compiler/runtime enforced. */
    registered: __gh_client_contract.defineContractMethod<
      PayMVC.v0_1.RegisteredArgs,
      PayMVC.v0_1.RegisteredResult,
      PayMVC.v0_1.DeclaredException
    >({
      interfaceName: "PayMVC",
      interfaceVersion: "0.1.0",
      abiName: "registered",
      publicName: "registered",
      entrypoint: __gh_entrypoints.PayMVC.v0_1.registered,
      effect: spec.interfaces[0]!.methods[10]!.effect,
      args: [
        {
          abiName: "account",
          publicName: "account",
          type: spec.interfaces[0]!.methods[10]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[10]!.return_type,
      throws: [
        {
          selector: 0x960e1141659f0779n,
          name: "PaymentError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    request: __gh_client_contract.defineContractMethod<
      PayMVC.v0_1.RequestArgs,
      PayMVC.v0_1.RequestResult,
      PayMVC.v0_1.DeclaredException
    >({
      interfaceName: "PayMVC",
      interfaceVersion: "0.1.0",
      abiName: "request",
      publicName: "request",
      entrypoint: __gh_entrypoints.PayMVC.v0_1.request,
      effect: spec.interfaces[0]!.methods[11]!.effect,
      args: [
        {
          abiName: "payer",
          publicName: "payer",
          type: spec.interfaces[0]!.methods[11]!.args[0]!.ty,
        },
        {
          abiName: "amount",
          publicName: "amount",
          type: spec.interfaces[0]!.methods[11]!.args[1]!.ty,
        },
        {
          abiName: "operation",
          publicName: "operation",
          type: spec.interfaces[0]!.methods[11]!.args[2]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[11]!.return_type,
      throws: [
        {
          selector: 0x960e1141659f0779n,
          name: "PaymentError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    send: __gh_client_contract.defineContractMethod<
      PayMVC.v0_1.SendArgs,
      PayMVC.v0_1.SendResult,
      PayMVC.v0_1.DeclaredException
    >({
      interfaceName: "PayMVC",
      interfaceVersion: "0.1.0",
      abiName: "send",
      publicName: "send",
      entrypoint: __gh_entrypoints.PayMVC.v0_1.send,
      effect: spec.interfaces[0]!.methods[12]!.effect,
      args: [
        {
          abiName: "to",
          publicName: "to",
          type: spec.interfaces[0]!.methods[12]!.args[0]!.ty,
        },
        {
          abiName: "amount",
          publicName: "amount",
          type: spec.interfaces[0]!.methods[12]!.args[1]!.ty,
        },
        {
          abiName: "operation",
          publicName: "operation",
          type: spec.interfaces[0]!.methods[12]!.args[2]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[12]!.return_type,
      throws: [
        {
          selector: 0x960e1141659f0779n,
          name: "PaymentError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
  },
} as const;

export const paymvc = {
  v0_1: {
    implementation: {
      Kind: {
        "Transfer": 0n,
        "Request": 1n,
      },
      PaymentError: {
        "AlreadyRegistered": 1n,
        "NotRegistered": 2n,
        "InvalidParticipants": 3n,
        "InvalidAmount": 4n,
        "InvalidOperation": 5n,
        "OperationUsed": 6n,
        "NotFound": 7n,
        "Unauthorized": 8n,
        "NotPending": 9n,
        "InvalidPage": 10n,
      },
      State: {
        "Pending": 0n,
        "Paid": 1n,
        "Declined": 2n,
      },
    },
  },
} as const;

// The types the namespaces above refer to, under names no declaration can capture.
export namespace __gh_codegen {
  export type paymvc$v0_1$implementation$Entry = paymvc.v0_1.implementation.Entry;
  export type paymvc$v0_1$implementation$Kind = paymvc.v0_1.implementation.Kind;
  export type paymvc$v0_1$implementation$PaymentError = paymvc.v0_1.implementation.PaymentError;
  export type paymvc$v0_1$implementation$State = paymvc.v0_1.implementation.State;
}
