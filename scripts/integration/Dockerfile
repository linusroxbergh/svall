# One disposable Ubuntu 24.04 machine for the fleet handover integration run: systemd as PID 1 (the companion
# runs as systemd user units), sshd, and the tools a handover drives. No Node and no checkout: the release brings its own.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus dbus-user-session libpam-systemd \
      openssh-server openssh-client rsync tmux git iptables socat procps ca-certificates xz-utils \
 && rm -rf /var/lib/apt/lists/*

# what a container has no use for, and what would wait on hardware it does not have
RUN systemctl mask getty@tty1.service console-getty.service systemd-udevd.service systemd-udev-trigger.service \
      systemd-networkd-wait-online.service apt-daily.timer apt-daily-upgrade.timer motd-news.timer \
 && systemctl enable ssh.service

# the machines reach each other on the container network, so `host add`'s tailscale check meets a double that
# answers its version and nothing else, as the unit tests' does
RUN printf '#!/bin/sh\n[ "$1" = version ] && { echo 0.0.0-integration; exit 0; }\necho "tailscale is a test double" >&2\nexit 1\n' \
      > /usr/local/bin/tailscale \
 && chmod 755 /usr/local/bin/tailscale

# the one account on each machine, at the same home path; key logins only, and never locked
RUN userdel -r ubuntu 2>/dev/null || true \
 && useradd -m -s /bin/bash -u 1000 archi \
 && usermod -p '*' archi \
 && mkdir -p /var/lib/systemd/linger \
 && touch /var/lib/systemd/linger/archi

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
