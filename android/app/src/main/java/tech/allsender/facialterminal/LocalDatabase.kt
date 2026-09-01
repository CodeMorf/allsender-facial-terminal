package tech.allsender.facialterminal

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase

@Entity(tableName = "face_templates")
data class FaceTemplateEntity(
    @androidx.room.PrimaryKey val key: String,
    val branchId: String,
    val employeeId: String,
    val version: Long,
    val encryptedPayload: String,
)

@Entity(tableName = "sync_metadata")
data class SyncMetadataEntity(
    @androidx.room.PrimaryKey val branchId: String,
    val facesVersion: Long,
    val lastSuccessfulSync: Long?,
)

@Entity(tableName = "offline_punches")
data class OfflinePunchEntity(
    @androidx.room.PrimaryKey val localEventId: String,
    val branchId: String,
    val terminalId: String,
    val encryptedPayload: String,
    val state: String = "PENDING",
    val retryCount: Int = 0,
    val lastError: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
)

@Dao
interface FaceTemplateDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(template: FaceTemplateEntity)

    @Query("DELETE FROM face_templates WHERE branchId = :branchId")
    suspend fun clearBranch(branchId: String)

    @Query("DELETE FROM face_templates WHERE key = :key")
    suspend fun delete(key: String)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveMetadata(metadata: SyncMetadataEntity)

    @Query("DELETE FROM sync_metadata WHERE branchId = :branchId")
    suspend fun clearMetadata(branchId: String)

    @Query("SELECT * FROM sync_metadata WHERE branchId = :branchId LIMIT 1")
    suspend fun metadata(branchId: String): SyncMetadataEntity?
}

@Dao
interface OfflinePunchDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(event: OfflinePunchEntity)

    @Query("SELECT * FROM offline_punches WHERE state IN ('PENDING','SYNCING') ORDER BY createdAt ASC LIMIT :limit")
    suspend fun pending(limit: Int): List<OfflinePunchEntity>

    @Query("UPDATE offline_punches SET state = :state, lastError = :error WHERE localEventId = :id")
    suspend fun setState(id: String, state: String, error: String? = null)

    @Query("UPDATE offline_punches SET state = 'FAILED', retryCount = retryCount + 1, lastError = :error WHERE localEventId = :id")
    suspend fun markFailed(id: String, error: String)

    @Query("UPDATE offline_punches SET state = 'PENDING', retryCount = retryCount + 1, lastError = :error WHERE localEventId = :id")
    suspend fun markRetry(id: String, error: String)

    @Query("DELETE FROM offline_punches WHERE localEventId = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM offline_punches")
    suspend fun clearAll()
}

@Database(
    entities = [FaceTemplateEntity::class, SyncMetadataEntity::class, OfflinePunchEntity::class],
    version = 1,
    exportSchema = false,
)
abstract class LocalDatabase : RoomDatabase() {
    abstract fun faceTemplates(): FaceTemplateDao
    abstract fun offlinePunches(): OfflinePunchDao

    companion object {
        @Volatile private var instance: LocalDatabase? = null

        fun get(context: android.content.Context): LocalDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    LocalDatabase::class.java,
                    "allsender-facial-local.db",
                ).build().also { instance = it }
            }
    }
}
