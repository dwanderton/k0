# k0

k0 listens to your side of a live customer call and surfaces the right knowledge-base passage as you speak. Restate the customer's question aloud and the answer lands on screen, highlighted and sourced, before you say "let me check."

## Repo

| where | what |
|---|---|
| [`web/`](web/README.md) | the app — setup, env, data pipeline, file map |
| [`scorecard/`](scorecard/SCORECARD.md) | quality history — append-only runs, method, gates |
| [`.github/workflows/`](.github/workflows/) | CI: per-PR hallucination gate · weekly corpus refresh |

Dev setup lives in [web/README.md](web/README.md)
