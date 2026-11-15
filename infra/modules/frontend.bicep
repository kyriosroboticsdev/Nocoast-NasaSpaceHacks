// Static Web App for the Vite/Three.js frontend. Deployment content comes from CI
// (.github/workflows/azure-deploy.yml), not from this template — this just provisions the resource.
//
// The frontend already calls the backend with relative paths (`${import.meta.env.BASE_URL}api/analyze`,
// see src/app.ts / src/science/backend.ts) because in local dev Vite proxies `/api` to the FastAPI
// process. The `linkedBackends` resource below reproduces that same same-origin behavior in production:
// Static Web Apps forwards any `/api/*` request to the Container App, so no frontend code changes needed.
param location string
param staticWebAppName string
param backendResourceId string
param backendRegion string = location

resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: staticWebAppName
  location: location
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {
    buildProperties: {
      skipGithubActionWorkflowGeneration: true
    }
  }
}

resource linkedBackend 'Microsoft.Web/staticSites/linkedBackends@2023-12-01' = {
  parent: staticWebApp
  name: 'api'
  properties: {
    backendResourceId: backendResourceId
    region: backendRegion
  }
}

output defaultHostname string = staticWebApp.properties.defaultHostname
output name string = staticWebApp.name
