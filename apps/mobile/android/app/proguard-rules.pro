# kotlinx.serialization: preserva serializers gerados dos modelos do núcleo.
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class com.avilaops.erp.core.** { *** Companion; }
-keepclasseswithmembers class com.avilaops.erp.core.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class com.avilaops.erp.core.**$$serializer { *; }
