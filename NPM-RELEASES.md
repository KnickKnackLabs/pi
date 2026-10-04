# Fork npm releases

The fork publishes public workspaces as `@knickknacklabs/*`. Source package names
and imports stay `@earendil-works/*`; the publisher creates temporary scoped
copies and aliases their sibling dependencies. Published repository metadata
points to KnickKnackLabs/pi. Source manifests and build output are not renamed.

## Before the first publication

Land and validate the packaging changes, reconcile generated model data, and
prepare an exact signed fork release tag. All public workspace versions must
match that tag. Do not publish uncommitted build output as an already released
version. Existing versions cannot be replaced on npm.

The npm organization owner must bootstrap the packages using an approved
publication from reviewed tarballs. The publisher's normal mode requests
provenance and is intended for GitHub Actions, not a local bootstrap. Local
bootstrap tarballs can be produced without registry access:

```sh
node scripts/publish.mjs --scope knickknacklabs --pack-only --out /tmp/pi-npm-release
```

This requires an existing validated build. Publishing those archives is a
separate human-approved step; do not run it merely to test installation.

The fork uses the explicit npm dist-tag `latest`. For an approved local bootstrap,
include `--tag latest --access public --ignore-scripts --provenance=false` when
publishing each reviewed archive. Current npm rejects prerelease-form versions
with an implicit dist-tag. Local bootstrap does not claim GitHub provenance.

Once the packages exist, configure each package's trusted publisher on npm:

- GitHub organization: `KnickKnackLabs`
- Repository: `pi`
- Workflow filename: `release-npm-kkl.yml`
- Environment: `npm-publish`

Configure that GitHub environment with required reviewers and release-tag
restrictions. Do not add a long-lived npm publishing token to the workflow.
Organization ownership alone does not establish that trusted publishing works.

## Subsequent releases

Prepare a signed `vX.Y.Z-kkl.N` tag using the fork's release process. Dispatch
**KKL npm Release** with that exact tag and `publish=false` first. It checks the
source, runs packaging tests, builds with pinned model data, and validates
scoped packages. It does not refresh the live model catalog or modify the
upstream pi.dev release announcement.

After approval, dispatch the same tag with `publish=true`. npm uses GitHub OIDC
and provenance; the publisher skips package versions already present. A partial
publish can be retried at the same tag after the underlying failure is resolved.
Never change the contents of a version already published.

The workflow uses npm 11.5.1, which supports trusted publishing. It is manual,
serialized, limited to KnickKnackLabs/pi, and defaults to validation only. No
workflow was dispatched while implementing it.

After publication, the workflow downloads every public package archive and
installs only the coding-agent npm alias in a fresh consumer outside the source
checkout. It verifies matching fork siblings, core runtime imports, and extension
types with dependency declaration checking skipped. No provider requests or
lifecycle scripts run. The verifier can also be rerun independently:

```sh
node scripts/verify-scoped-release.mjs --scope knickknacklabs
```

The local-registry experiment established that installing coding-agent alone
retrieves its five matching fork siblings without direct consumer entries.

## Extension development

Keep existing import names and use npm aliases for fork development packages:

```json
{
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "npm:@knickknacklabs/pi-coding-agent@0.87.1-kkl.2"
  }
}
```

The example illustrates the version format, not package availability. Use the
exact version actually published and aligned with your running host. Add aliases
for other Pi libraries your extension imports directly. Pi provides host
libraries at extension runtime; development installations supply editor/types.

The tested full declaration-checking setup uses TypeScript Bundler resolution,
Node type definitions 22.19.19, and Google's optional MCP peer installed
(@modelcontextprotocol/sdk 1.25.2 in the experiment). NodeNext checks currently
fail on emitted JSON-import declarations. Newer Node definitions removed
path.PlatformPath, and omitting MCP can break Google SDK declaration checking.
These limitations are tracked, not silently waived as universal compatibility.
`skipLibCheck` is another practical consumer option but does not validate library
declarations internally.

## Upstream upgrades

The package list is discovered from public workspace manifests; sibling aliases
and shrinkwrap URLs are generated for that list. The machinery is not hardcoded
to the 0.87.1 base. After an upstream upgrade, review changed workspace layout,
exports, dependencies, lockfiles, and consumer compatibility before releasing.
A successful older release does not prove a new major upstream version works.
