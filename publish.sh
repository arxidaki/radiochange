#!/bin/sh
# Publish the player to GitHub Pages.
#
# The site is one page: the committed mockups/radio-change.html goes out as
# index.html on the gh-pages branch, with engine.js and the logo beside it.
# Nothing else in the repo is published, and the working tree is not touched.
#
#   sh publish.sh            publish to origin
#   sh publish.sh <remote>   publish to another remote
set -e
cd "$(git rev-parse --show-toplevel)"
remote=${1:-origin}

tree=$(printf '100644 blob %s\t%s\n' \
  "$(git rev-parse HEAD:mockups/radio-change.html)" index.html \
  "$(git rev-parse HEAD:mockups/engine.js)" engine.js \
  "$(git rev-parse HEAD:mockups/radio-change-logo.png)" radio-change-logo.png \
  "$(git rev-parse HEAD:mockups/.nojekyll)" .nojekyll | git mktree)

# build on what is already published, so the push is never a forced one
parent=$(git ls-remote "$remote" refs/heads/gh-pages | cut -f1)
if [ -n "$parent" ]; then git fetch -q "$remote" gh-pages; fi

if [ -n "$parent" ] && [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
  echo "Nothing new to publish."
  exit 0
fi

commit=$(git commit-tree "$tree" ${parent:+-p "$parent"} -m "Publish $(git rev-parse --short HEAD)")
git push "$remote" "$commit:refs/heads/gh-pages"
