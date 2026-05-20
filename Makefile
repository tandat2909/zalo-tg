.PHONY: kill-port build start restart

PORT ?= 3000

kill-port:
	@echo "Killing process on port $(PORT) if any..."
	@fuser -k $(PORT)/tcp 2>/dev/null || true

build: kill-port
	npm run build

start: kill-port
	npm run start

restart: build start
