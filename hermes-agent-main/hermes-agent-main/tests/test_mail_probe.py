"""Tests for the hermes_cli.mail_probe SSRF guard (MBOX-468, Linus blocker).

_host_block_reason must reject loopback / link-local (incl. the cloud metadata
IP) / private / unspecified targets, and the IMAP/SMTP probes must short-circuit
on it WITHOUT opening a connection. Public IP literals pass. No network: IP
literals and 'localhost' resolve locally.
"""
import pytest

from hermes_cli import mail_probe


@pytest.mark.parametrize(
    "host",
    [
        "127.0.0.1",        # loopback
        "localhost",        # loopback (local resolution)
        "169.254.169.254",  # cloud metadata (link-local)
        "10.0.0.1",         # RFC1918
        "172.16.5.4",       # RFC1918
        "192.168.1.1",      # RFC1918
        "0.0.0.0",          # unspecified
        "::1",              # IPv6 loopback
        "",                 # empty
    ],
)
def test_host_block_reason_blocks_internal(host):
    assert mail_probe._host_block_reason(host) is not None


@pytest.mark.parametrize("host", ["1.1.1.1", "8.8.8.8", "93.184.216.34"])
def test_host_block_reason_allows_public_literals(host):
    assert mail_probe._host_block_reason(host) is None


def test_probe_imap_refuses_private_host_without_connecting():
    res = mail_probe._probe_imap("127.0.0.1", 993, "u", "p")
    assert res["ok"] is False
    assert "imap host" in res["detail"].lower()


def test_probe_smtp_refuses_private_host_without_connecting():
    res = mail_probe._probe_smtp("169.254.169.254", 587, "u", "p")
    assert res["ok"] is False
    assert "smtp host" in res["detail"].lower()
