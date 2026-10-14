#!/usr/bin/env bash
# One-command local Kubernetes bring-up:
#   kind cluster -> ingress-nginx -> build & load images -> apply k8s/ manifests
# Usage: ./scripts/kind-up.sh            (core app + platform services)
#        WITH_OBSERVABILITY=1 ./scripts/kind-up.sh
set -euo pipefail

CLUSTER=${CLUSTER:-node-react}
REPO_IMG=${REPO_IMG:-ghcr.io/nahmxp/node-react-postgres-platform-assessment}
TAG=${TAG:-local}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --config k8s/cluster/kind-config.yaml
fi
kubectl config use-context "kind-$CLUSTER"

echo ">> Installing ingress-nginx (kind provider manifest)"
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.2/deploy/static/provider/kind/deploy.yaml
kubectl wait -n ingress-nginx --for=condition=ready pod \
  -l app.kubernetes.io/component=controller --timeout=420s

# Return 429 (not the default 503) when the Ingress rate limit is hit.
kubectl patch configmap ingress-nginx-controller -n ingress-nginx --type merge   -p '{"data":{"limit-req-status-code":"429","limit-conn-status-code":"429"}}'

echo ">> Installing metrics-server (needed by the HPA)"
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml
# kind's kubelet uses self-signed certs
kubectl patch -n kube-system deployment metrics-server --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' || true

echo ">> Building and loading images into kind"
docker build -f Dockerfile.backend  -t "$REPO_IMG-backend:$TAG"  .
docker build -f Dockerfile.frontend -t "$REPO_IMG-frontend:$TAG" .
kind load docker-image --name "$CLUSTER" "$REPO_IMG-backend:$TAG" "$REPO_IMG-frontend:$TAG"

echo ">> Applying manifests"
kubectl apply -f k8s/namespace-dev.yaml
kubectl apply -f k8s/

kubectl rollout status -n dev deployment/postgres --timeout=420s
kubectl rollout status -n dev deployment/backend  --timeout=420s
kubectl rollout status -n dev deployment/frontend --timeout=420s

if [[ "${WITH_OBSERVABILITY:-0}" == "1" ]]; then
  echo ">> Deploying observability stack"
  kubectl apply -f observability/
fi

kubectl get all -n dev
echo
echo "Add to your hosts file:  127.0.0.1 node-react.local"
echo "Then open:               http://node-react.local"
