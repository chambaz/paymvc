# PayMVC website

The PayMVC landing page. It introduces the project and links to each network's demo and the GitHub repository. It has no wallet or chain code.

## Run

Requirements: Node 24+ and npm. Run commands from this directory.

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:5170>.

To make a production build in `dist/`:

```sh
npm run build
```

Run `npm run check` before you commit. It runs the type check and the Prettier check.

## Configuration

| Variable             | Default                                    | Use                                               |
| -------------------- | ------------------------------------------ | ------------------------------------------------- |
| `VITE_ETHEREUM_URL`  | `http://127.0.0.1:5173/?network=ethereum`  | The Ethereum demo. **Launch Demo** also opens it. |
| `VITE_BASE_URL`      | `http://127.0.0.1:5177/?network=base`      | The Base demo.                                    |
| `VITE_ROBINHOOD_URL` | `http://127.0.0.1:5187/?network=robinhood` | The Robinhood demo.                               |
| `VITE_MONAD_URL`     | `http://127.0.0.1:5179/?network=monad`     | The Monad demo.                                   |
| `VITE_SOLANA_URL`    | `http://127.0.0.1:5175`                    | The Solana demo.                                  |
| `VITE_SUI_URL`       | `http://127.0.0.1:5183`                    | The Sui demo.                                     |
| `VITE_APTOS_URL`     | `http://127.0.0.1:5185`                    | The Aptos demo.                                   |
| `VITE_STELLAR_URL`   | `http://127.0.0.1:5181`                    | The Stellar demo.                                 |
| `VITE_THRUPUT_URL`   | `http://127.0.0.1:5189`                    | The Thruput demo.                                 |

Hosted builds set every variable to the network's subdomain, for example `https://base.paymvc.com`.

On Railway, Caddy serves the build with `Caddyfile.template`: Railpack's default Node template, a permanent redirect from `www.paymvc.com` to `paymvc.com`, and these headers:

- A Content Security Policy. It allows only this site's scripts, fonts, and images, and this site's styles plus inline styles, which UI libraries set at runtime. It blocks frames, plugins, and form posts. `connect-src` lists the hosts the app may call, and `node conformance/verify.mjs` checks that it includes every deployment's `rpcUrl`.
- HSTS, `Referrer-Policy: no-referrer`, a `Permissions-Policy` that turns off device APIs, `Cross-Origin-Opener-Policy: same-origin`, and `nosniff`.
- `Cache-Control`: hashed files in `/assets/` are cached for a year. Every other file, including the page and the deployment record, is checked on each load. A missing file in `/assets/` returns 404, not the page, so a browser never caches the page under an asset's name.

Each implementation has a copy of this file. The copies differ only in `connect-src`, which lists the RPC hosts that the implementation calls. `node conformance/verify.mjs` checks this.

To open the local demo, start the EVM implementation too. See [`implementations/ethereum/foundry`](../implementations/ethereum/foundry/README.md).

## Design

The page uses the demo's neutral theme: `src/styles.css` and `public/theme.js` are copies of the demo's shared files. `src/components/` has small copies of the demo's button and theme toggle. The theme preference uses the same storage key as the demo.

Network marks are monochrome SVGs, applied as CSS masks so that they follow the theme. Their sources are listed in [`src/assets/README.md`](src/assets/README.md).

## Icons and link previews

`scripts/assets.mjs` makes the favicon set and the Open Graph image in `public/`:

- `favicon.svg`, `favicon.ico`, and `apple-touch-icon.png`: a "p." monogram from Inter SemiBold outlines. The SVG follows the browser's light or dark setting.
- `og.png`: the 1200×630 link preview image, in the dark theme. All sites link to the hosted copy at <https://paymvc.com/og.png>.

The build does not make these files. After you change the script, run it and commit the outputs:

```sh
npx playwright install chromium
npm run assets
```
