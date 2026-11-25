# Keep Kotlinx Serialization generated serializers
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class dev.dropit.app.**$$serializer { *; }
-keepclassmembers class dev.dropit.app.** {
    *** Companion;
}
-keepclasseswithmembers class dev.dropit.app.** {
    kotlinx.serialization.KSerializer serializer(...);
}
