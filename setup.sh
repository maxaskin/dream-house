#!/bin/sh
# Run this once after cloning the repo on a new machine.
# Git does NOT clone local config, so the committed hooks in .githooks/
# stay inactive until core.hooksPath is pointed at them.
#
#   sh setup.sh
#
git config core.hooksPath .githooks
echo "core.hooksPath -> .githooks (pre-commit will rebuild HTML from property_data.json)"
