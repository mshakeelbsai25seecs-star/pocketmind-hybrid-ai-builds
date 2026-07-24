# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.kts.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Kotlin
-dontwarn kotlin.**
-keepattributes Signature
-keepattributes *Annotation*
-keepattributes InnerClasses
-keepattributes EnclosingMethod

# Kotlinx Serialization
-keepattributes RuntimeVisibleAnnotations, AnnotationDefault
-keep,includedescriptorclasses class com.pocketmind.hybridai.**$$serializer { *; }
-keepclassmembers class com.pocketmind.hybridai.** {
    *** Companion;
}
-keepclasseswithmembers class com.pocketmind.hybridai.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Hilt / Dagger
-dontwarn com.google.errorprone.annotations.**
-keep class dagger.hilt.** { *; }
-keep class javax.inject.** { *; }
-keep class * extends dagger.hilt.android.HiltAndroidApp

# Room
-keep class androidx.room.** { *; }
-dontwarn androidx.room.paging.**

# OkHttp / Okio
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn javax.annotation.**
-keepnames class okhttp3.internal.publicsuffix.PublicSuffixDatabase

# Coil
-dontwarn coil.**

# Keep model / data classes used for JSON (de)serialization.
-keep class com.pocketmind.hybridai.**.model.** { *; }
-keep class com.pocketmind.hybridai.**.data.** { *; }
