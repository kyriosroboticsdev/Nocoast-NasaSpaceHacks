// Lunar Landing Site Navigator — Azure infrastructure.
// Scope: subscription. Creates one resource group and everything inside it.
//
// Pieces:
//   - Storage Account (Blob)   -> cache for NASA LOLA DEM / SPICE kernel downloads (backend/azure_cache.py)
//   - Container Registry       -> holds the backend API image
//   - Container Apps env + app -> runs the FastAPI backend: terrain-horizon + ephemeris + pathfinding compute
//   - Static Web App           -> hosts the Vite/Three.js frontend
//   - Log Analytics + App Insights -> shared observability for the Container App
//
// Deploy (once Azure details/credentials are provided):
//   az deployment sub create \
//     --location <region> \
//     --template-file infra/main.bicep \
//     --parameters infra/main.parameters.json
//
// Nothing here talks to a subscription until `az deployment` is actually run — safe to keep checked in
// with placeholder parameter values.

targetScope = 'subscription'

@description('Short, unique project prefix used in resource names (lowercase, alphanumeric).')
param projectName string = 'lunarnav'

@description('Environment suffix, e.g. dev / preview / prod.')
param envName string = 'dev'

@description('Azure region for all resources.')
param location string = 'westus2'

@description('Name of the resource group to create/use.')
param resourceGroupName string = '${projectName}-${envName}-rg'

var nameBase = '${projectName}${envName}'

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  scope: rg
  params: {
    location: location
    storageAccountName: take(toLower('${nameBase}${uniqueString(rg.id)}'), 24) // storage names: 3-24 lowercase alphanumerics
  }
}

module registry 'modules/registry.bicep' = {
  name: 'registry'
  scope: rg
  params: {
    location: location
    registryName: toLower('${nameBase}acr${uniqueString(rg.id)}')
  }
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  scope: rg
  params: {
    location: location
    namePrefix: nameBase
  }
}

module backend 'modules/backend.bicep' = {
  name: 'backend'
  scope: rg
  params: {
    location: location
    namePrefix: nameBase
    registryLoginServer: registry.outputs.loginServer
    registryName: registry.outputs.name
    storageAccountName: storage.outputs.name
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
  }
}

module frontend 'modules/frontend.bicep' = {
  name: 'frontend'
  scope: rg
  params: {
    location: location
    staticWebAppName: '${nameBase}-web'
    backendResourceId: backend.outputs.id
  }
}

output resourceGroupName string = rg.name
output backendUrl string = backend.outputs.fqdn
output frontendDefaultHostname string = frontend.outputs.defaultHostname
output storageAccountName string = storage.outputs.name
output containerRegistryLoginServer string = registry.outputs.loginServer
