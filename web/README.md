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
