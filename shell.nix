{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
  buildInputs = [
    pkgs.nodejs
  ];
    shellHook = ''
    npm set prefix $PWD/.npm-global
    export PATH=$PWD/.npm-global/bin:$PATH
    export NODE_PATH=$PWD/.npm-global/lib/node_modules
    GIT_AUTHOR_EMAIL='florian-marie@getvirtualbrain.com'
	export CLAUDE_CODE_USE_BEDROCK=1
	export ANTHROPIC_MODEL=eu.anthropic.claude-opus-4-6-v1
	export AWS_REGION=eu-west-3
	export AWS_PROFILE=virtualbrain-local-dev
  '';
}