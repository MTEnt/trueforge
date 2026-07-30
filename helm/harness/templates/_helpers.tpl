{{/*
Naming and label helpers, plus the derived Postgres and Redis connection
details that the server's env vars are built from.
*/}}

{{- define "harness.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "harness.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "harness.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "harness.server.fullname" -}}
{{- printf "%s-server" (include "harness.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "harness.frontend.fullname" -}}
{{- printf "%s-frontend" (include "harness.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "harness.postgres.fullname" -}}
{{- printf "%s-postgres" (include "harness.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "harness.redis.fullname" -}}
{{- printf "%s-redis" (include "harness.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "harness.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "harness.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "harness.labels" -}}
helm.sh/chart: {{ include "harness.chart" . }}
app.kubernetes.io/name: {{ include "harness.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector labels for one component. Call with (dict "root" . "component" "server"). */}}
{{- define "harness.selectorLabels" -}}
app.kubernetes.io/name: {{ include "harness.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Fully qualified image ref. Call with (dict "root" . "image" .Values.server.image). */}}
{{- define "harness.image" -}}
{{- $registry := .root.Values.imageRegistry -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry .image.repository .image.tag -}}
{{- else -}}
{{- printf "%s:%s" .image.repository .image.tag -}}
{{- end -}}
{{- end -}}

{{- define "harness.postgres.host" -}}
{{- if .Values.postgres.enabled -}}
{{- include "harness.postgres.fullname" . -}}
{{- else -}}
{{- .Values.postgres.external.host -}}
{{- end -}}
{{- end -}}

{{- define "harness.postgres.port" -}}
{{- if .Values.postgres.enabled -}}
{{- .Values.postgres.service.port -}}
{{- else -}}
{{- .Values.postgres.external.port -}}
{{- end -}}
{{- end -}}

{{- define "harness.redis.url" -}}
{{- if .Values.redis.enabled -}}
{{- printf "redis://%s:%v" (include "harness.redis.fullname" .) .Values.redis.service.port -}}
{{- else -}}
{{- .Values.redis.external.url -}}
{{- end -}}
{{- end -}}

{{/* Secret holding the Postgres password, whether bundled or user-managed. */}}
{{- define "harness.postgres.secretName" -}}
{{- if .Values.postgres.auth.existingSecret -}}
{{- .Values.postgres.auth.existingSecret -}}
{{- else -}}
{{- include "harness.postgres.fullname" . -}}
{{- end -}}
{{- end -}}

{{- define "harness.postgres.secretPasswordKey" -}}
{{- if .Values.postgres.auth.existingSecret -}}
{{- .Values.postgres.auth.existingSecretPasswordKey -}}
{{- else -}}
{{- "POSTGRES_PASSWORD" -}}
{{- end -}}
{{- end -}}

{{- define "harness.server.secretName" -}}
{{- default (include "harness.server.fullname" .) .Values.server.existingSecret -}}
{{- end -}}

{{- define "harness.registry.configMapName" -}}
{{- default (printf "%s-registry" (include "harness.fullname" .)) .Values.registry.existingConfigMap -}}
{{- end -}}

{{/*
Settings the server would otherwise reject at boot. Checked here so a bad
install fails during rendering instead of in a CrashLoopBackOff.
*/}}
{{- define "harness.validate" -}}
{{- if and (not .Values.postgres.enabled) (not .Values.postgres.external.host) -}}
{{- fail "postgres.enabled is false, so postgres.external.host must be set" -}}
{{- end -}}
{{- if and (not .Values.redis.enabled) (not .Values.redis.external.url) -}}
{{- fail "redis.enabled is false, so redis.external.url must be set" -}}
{{- end -}}
{{- if and (not .Values.server.existingSecret) (not (get .Values.server.secretEnv "MODEL_API_KEY")) -}}
{{- fail "server.secretEnv.MODEL_API_KEY is required unless server.existingSecret provides it" -}}
{{- end -}}
{{- end -}}
