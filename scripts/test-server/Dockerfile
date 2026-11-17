# A "fresh VM" for SSH tests: systemd as PID 1, an SSH server, nothing else.
# Docker is NOT preinstalled; `lotse server setup` installs it, as on a real server.
# Needs --privileged because Docker will run inside (see ../test-server.sh).
ARG BASE=ubuntu:24.04
FROM ${BASE}
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus openssh-server sudo ca-certificates curl iproute2 iptables kmod procps \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
      systemd-modules-load.service sys-kernel-debug.mount sys-kernel-tracing.mount sys-kernel-config.mount \
      getty.target console-getty.service systemd-logind.service systemd-resolved.service systemd-networkd.service \
      systemd-timesyncd.service apt-daily.timer apt-daily-upgrade.timer \
 && mkdir -p /run/sshd \
 && printf 'PermitRootLogin yes\nPasswordAuthentication yes\nKbdInteractiveAuthentication no\n' > /etc/ssh/sshd_config.d/10-lotse-test.conf \
 && (systemctl enable ssh.service || systemctl enable sshd.service)
ARG ROOT_PASSWORD=lotse-test-password
RUN echo "root:${ROOT_PASSWORD}" | chpasswd
# Docker inside a container needs real volumes for its storage (no overlay on overlay).
VOLUME ["/var/lib/docker", "/var/lib/containerd"]
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
