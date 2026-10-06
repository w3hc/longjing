# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/w3hc/longjing/security/advisories/new). Don't open a public issue, pull request or discussion for a vulnerability.

Include what you can of:

- the affected component (backend, contract, circuit, Docker or compose, docs) and the commit or release
- a description of the issue and its impact
- steps or a proof of concept to reproduce it

You should get an acknowledgement within 7 days. Once a fix is ready, it ships in a release and the advisory is published, with credit to you unless you prefer otherwise.

## Supported versions

Only the latest release gets security fixes. Earlier releases are not patched: upgrade instead.

| Version | Supported |
| --- | --- |
| 0.4.x | Yes |
| < 0.4 | No |

## Scope

In scope: everything in this repository, including the NestJS server in `src/`, the contracts in `contracts/src/`, the circuits in `circuits/`, the pinned circuit artifacts, the Docker and compose files, and the CI workflows.

Out of scope: the upstream API providers, dstack and the TEE hardware, and third-party deployments of Longjing.

## Current status

Longjing has had an internal, AI-performed review but no independent third-party audit, and no deployment holding real value exists. Known limitations are stated in the README under [Status](README.md#status) and [What this protects — and what it doesn't](README.md#what-this-protects--and-what-it-doesnt). Reports about those known limitations are still welcome when they show a new impact or a new way to exploit them.
