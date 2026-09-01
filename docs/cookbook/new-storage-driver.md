# New storage driver

Add a backend next to local disk and S3: implement `StorageDriver`, add env + validation, wire a factory, then register it in `InitDrivers()`.

The full checklist is on [Storage — Adding a new driver](/packages/storage/advanced#adding-a-new-driver).
