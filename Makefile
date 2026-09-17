.PHONY: install build test start dev clean setup install-mcp first-connect connect-github disconnect

install:
	npm install
	npm run build

build:
	npm run build

test:
	npm test

start:
	npm run start

dev:
	npm run dev

clean:
	npm run clean

setup:
	npm run setup

install-mcp:
	npm run install-mcp -- "$(TARGET)"

first-connect:
	npm run first-connect

connect-github:
	npm run connect-github

disconnect:
	npm run disconnect
