// Blob storage used as a persistent cache for the ~240MB of NASA LOLA DEMs / PGDA tiles / SPICE kernels
// that backend/scripts/fetch_data.py otherwise re-downloads from PDS/NAIF/JPL on every fresh machine or
// container cold start. See backend/azure_cache.py for the read/write side.
param location string
param storageAccountName string

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

resource scienceDataContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'science-data'
  properties: {
    publicAccess: 'None'
  }
}

output name string = storageAccount.name
output id string = storageAccount.id
output scienceDataContainerName string = scienceDataContainer.name
