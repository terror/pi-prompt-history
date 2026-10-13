set dotenv-load

export EDITOR := 'nvim'

alias c := check
alias f := fmt
alias l := lint

default:
  just --list

check:
  bun run check

fmt:
  bun run format

lint:
  bun run lint
