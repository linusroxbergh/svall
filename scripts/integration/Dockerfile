# One disposable Ubuntu 24.04 machine for the integration runs: systemd as PID 1 for the companion's user units, polkit
# so an account can turn lingering on as on Ubuntu Server, sshd and the tools a move drives; no Node, as the release
# brings its own. The `machine` stage has no account, as a fresh install makes one at the controller's home path.
FROM ubuntu:24.04 AS machine

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus dbus-user-session libpam-systemd polkitd \
      openssh-server openssh-client tmux git iptables procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# what a container has no use for, and what would wait on hardware it does not have
RUN systemctl mask getty@tty1.service console-getty.service systemd-udevd.service systemd-udev-trigger.service \
      systemd-networkd-wait-online.service apt-daily.timer apt-daily-upgrade.timer motd-news.timer \
 && systemctl enable ssh.service

# the machines have no tailnet, so `host add`'s tailscale check meets a double that answers its version and nothing
# else, as the unit tests' does
RUN printf '#!/bin/sh\n[ "$1" = version ] && { echo 0.0.0-integration; exit 0; }\necho "tailscale is a test double" >&2\nexit 1\n' \
      > /usr/local/bin/tailscale \
 && chmod 755 /usr/local/bin/tailscale

RUN userdel -r ubuntu 2>/dev/null || true

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

# the tmux-driven unit tests, as scripts/test-linux.mjs runs them from a Mac: python3 for the pty fixture, and the pinned
# Node and the tmux 3.7c a release ships, from a build context `bits` holding only those two
FROM machine AS tests
RUN apt-get update && apt-get install -y --no-install-recommends python3 xz-utils && rm -rf /var/lib/apt/lists/*
ARG NODE PNPM
COPY --from=bits $NODE /tmp/node.tar.xz
ENV COREPACK_HOME=/opt/corepack LANG=C.UTF-8
RUN tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components 1 && rm /tmp/node.tar.xz \
 && corepack enable pnpm && corepack prepare "pnpm@$PNPM" --activate && pnpm --version && chmod -R a+rX /opt/corepack
COPY --from=bits tmux /usr/local/bin/tmux
# the checkout is mounted from the Mac, owned by an account the container does not have
RUN useradd -m -s /bin/bash -u 1000 tester && git config --system safe.directory '*'

FROM machine

# the one account on each machine, in /home/svall until a run moves it; key logins only, and never locked
RUN useradd -m -s /bin/bash -u 1000 svall \
 && usermod -p '*' svall \
 && mkdir -p /var/lib/systemd/linger \
 && touch /var/lib/systemd/linger/svall
