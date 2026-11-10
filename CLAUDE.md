# vengex-org/ci

Shared GitHub Actions for the vengex Nx + bun monorepos; [README.md](README.md) describes the workflows and their inputs. Checks: `bun run lint`, `bun run fmt:check`, `bun run typecheck`, `bun run test`. `vengex-org/ci-fixture` is the workspace that calls these workflows end to end.

## Commit messages

One line, `<gitmoji> <type>(<scope>): <subject>`, with no body and no trailers. The scope is optional and names the app or package. The subject is imperative, starts lowercase and has no trailing period. An issue id, when there is one, goes right after the colon: `🐛 fix(server): #1234 keep the session on refresh`.

| gitmoji | type       | for                                   |
| ------- | ---------- | ------------------------------------- |
| ✨      | `feat`     | new behavior                          |
| 🐛      | `fix`      | a bug fix                             |
| 📝      | `docs`     | docs and vault notes                  |
| 🎨      | `style`    | formatting only                       |
| ♻️      | `refactor` | a code change that keeps the behavior |
| ⚡️      | `perf`     | speed                                 |
| ✅      | `test`     | tests only                            |
| 👷      | `ci`       | CI workflows                          |
| 🔧      | `chore`    | config and tooling                    |
| ⬆️      | `chore`    | a dependency upgrade                  |
| 🔖      | `chore`    | a version bump                        |
| 🔥      | `chore`    | removing unused code or files         |

Pull requests are squash-merged only (GitHub repository setting). The commit on `master` is the PR title plus ` (#<number>)` with an empty body, so the PR title uses the same format.
