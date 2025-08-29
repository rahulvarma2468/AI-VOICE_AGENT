#!/usr/bin/env bash
set -o errexit

# Upgrade pip + setuptools
pip install --upgrade pip setuptools wheel maturin

# Redirect Cargo cache to /tmp (writable on Render)
export CARGO_HOME=/tmp/cargo
export CARGO_TARGET_DIR=/tmp/target

# Install dependencies
pip install -r requirements.txt
