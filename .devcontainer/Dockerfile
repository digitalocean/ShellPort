FROM mcr.microsoft.com/devcontainers/base:ubuntu

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        build-essential \
        neovim \
        imagemagick \
        jq \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# yq - latest via GitHub redirect (no API call needed)
RUN curl -fsSL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64" \
        -o /usr/local/bin/yq \
 && chmod +x /usr/local/bin/yq

# doctl - pinned version, update ARG to bump
ARG DOCTL_VERSION=1.119.0
RUN curl -fsSL \
        "https://github.com/digitalocean/doctl/releases/download/v${DOCTL_VERSION}/doctl-${DOCTL_VERSION}-linux-amd64.tar.gz" \
        | tar -xz -C /usr/local/bin \
 && chmod +x /usr/local/bin/doctl

USER vscode

# Homebrew - installed as vscode user (devcontainer Feature has permission issues)
RUN NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
 && echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> /home/vscode/.bashrc \
 && echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> /home/vscode/.profile
