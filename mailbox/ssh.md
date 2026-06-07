# SSH into the MailBox One (Jetson)

## Quick connect

```
ssh mailbox
```

That works because `~/.ssh/config` on this workstation defines:

```
Host mailbox
    HostName 192.168.1.45
    User bob
    IdentityFile ~/.ssh/id_ed25519
```

## First-time key setup (already done on this box)

1. Generated a keypair:
   ```
   ssh-keygen -t ed25519 -N "" -C "bob@bob-TB250-BTC" -f ~/.ssh/id_ed25519
   ```
2. Copied the public key to the Jetson (run once, prompts for Jetson password):
   ```
   ssh-copy-id mailbox
   ```
3. Verify passwordless login:
   ```
   ssh mailbox 'hostname && whoami'
   ```

## Fallback — connect without the alias

```
ssh bob@192.168.1.45
```

## If the IP changes

The Jetson's LAN IP is assigned by DHCP. If the router hands it a new address:

1. Find it again:
   ```
   nmap -p 22 --open 192.168.1.0/24
   ```
   Look for an aarch64 Ubuntu banner.
2. Update `HostName` in `~/.ssh/config`.
3. To avoid this, set a DHCP reservation on the router for the Jetson's MAC.

## Useful one-liners once connected

```
ssh mailbox 'hostname -I'                     # check IPs
ssh mailbox 'cat /etc/nv_tegra_release'       # JetPack/L4T version
ssh mailbox 'docker ps'                       # running containers
ssh mailbox 'docker compose -f ~/mailbox/docker-compose.yml logs -f'
```
