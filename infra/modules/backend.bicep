// Container Apps environment + the backend API app (FastAPI: terrain horizon, ephemeris, pathfinding).
// Azure for Students subscriptions get "Express" Container Apps environments, which reject managed identities
// (system- or user-assigned) and every private-registry pull we tried. So: no identity, and the image is a
// public GHCR package pushed by .github/workflows/azure-deploy.yml. Blob Storage access is a connection
// string held as a Container App secret.
param location string
param namePrefix string
param storageAccountName string
param logAnalyticsWorkspaceId string
param appInsightsConnectionString string

@description('Placeholder image until the first CI build pushes a real one.')
param containerImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: last(split(logAnalyticsWorkspaceId, '/'))
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource containerAppEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource backendApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-api'
  location: location
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8765
        transport: 'auto'
      }
      secrets: [
        {
          name: 'storage-connection'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: containerImage
          resources: {
            // /api/analyze loads DE421 and builds a multi-hundred-KB time series per call; at 1 cpu / 2Gi
            // two concurrent analyses (plus the terrain/map calls the dashboard fires alongside) OOM-killed
            // the container, returning 502 and surfacing as "couldn't calculate / network error" in the UI.
            // 2 cpu / 4Gi gives headroom for the concurrent load and roughly halves the per-call time.
            cpu: json('2.0')
            memory: '4Gi'
          }
          env: [
            { name: 'AZURE_STORAGE_CONNECTION_STRING', secretRef: 'storage-connection' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
          ]
        }
      ]
      scale: {
        // Keep one replica warm. With minReplicas 0 the backend scaled to zero when idle, so the first
        // page load after a lull hit an ~8s cold start and the dashboard's parallel data calls failed
        // ("Failed to fetch" / "Terrain unavailable"). One always-on replica removes that cold start.
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
}

output fqdn string = backendApp.properties.configuration.ingress.fqdn
output id string = backendApp.id
output name string = backendApp.name
