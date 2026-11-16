# PayMVC website

The PayMVC landing page. It introduces the project, lists the supported networks, and links to the Ethereum demo and the GitHub repository. It has no wallet or chain code.

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

| Variable            | Default                                   | Use                                  |
| ------------------- | ----------------------------------------- | ------------------------------------ |
| `VITE_ETHEREUM_URL` | `http://127.0.0.1:5173/?network=ethereum` | The demo that **Launch Demo** opens. |

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
