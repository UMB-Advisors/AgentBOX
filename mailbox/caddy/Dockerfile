FROM caddy:2-builder AS builder
RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# STAQPRO-239 — fail-fast guard. Validates MAILBOX_BASIC_AUTH_USER /
# MAILBOX_BASIC_AUTH_HASH before invoking the upstream Caddy CMD.
# Catches the silent unauthenticated-edge failure mode that bit the
# customer-#2 install (empty hash + restart-instead-of-up-d).
COPY entrypoint.sh /usr/local/bin/mailbox-caddy-entrypoint.sh
RUN chmod +x /usr/local/bin/mailbox-caddy-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/mailbox-caddy-entrypoint.sh"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
