//! JPEG/PNG/GIF/WebP and limited AVIF raster for thumbnails and previews.
//!
//! Derived WebP is lossless, so compressed bytes differ from Sharp quality 75.
//! Callers compare dimensions, orientation, and stripped metadata.
//!
//! AVIF never uses `image::codecs::avif::AvifDecoder` or `ImageReader`. Those
//! paths construct dav1d with no frame-size limit. The order here is: sniff,
//! read `ispe` ourselves, reject oversized or missing extents, then dav1d with
//! `set_frame_size_limit` and a counting picture allocator.

use std::{
    alloc::{Layout, alloc, dealloc},
    io::Cursor,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use image::{
    DynamicImage, ExtendedColorType, ImageDecoder, ImageFormat,
    codecs::{
        gif::GifDecoder, jpeg::JpegDecoder, png::PngDecoder, webp::WebPDecoder, webp::WebPEncoder,
    },
};

use crate::ApiError;

pub const PIXEL_LIMIT: u64 = 16_777_216;
pub const THUMBNAIL_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
pub struct RasterError;

impl From<RasterError> for ApiError {
    fn from(_: RasterError) -> Self {
        ApiError::new(415, "INVALID_IMAGE")
    }
}

/// Decode a stored image and encode one WebP fitted inside `edge`.
pub fn derive(bytes: &[u8], edge: u32) -> Result<Vec<u8>, RasterError> {
    if let Ok(format) = image::guess_format(bytes)
        && matches!(
            format,
            ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::Gif | ImageFormat::WebP
        )
    {
        return derive_still(bytes, format, edge);
    }
    if is_avif(bytes) {
        return derive_avif(bytes, edge);
    }
    Err(RasterError)
}

pub fn derive_file(path: &std::path::Path, edge: u32) -> Result<Vec<u8>, RasterError> {
    let bytes = std::fs::read(path).map_err(|_| RasterError)?;
    derive(&bytes, edge)
}

fn derive_still(bytes: &[u8], format: ImageFormat, edge: u32) -> Result<Vec<u8>, RasterError> {
    let orientation = read_orientation(bytes);
    let image = decode_still(bytes, format)?;
    let oriented = apply_orientation(image, orientation);
    encode_fitted(&oriented, edge)
}

fn decode_still(bytes: &[u8], format: ImageFormat) -> Result<DynamicImage, RasterError> {
    let cursor = Cursor::new(bytes);
    match format {
        ImageFormat::Jpeg => {
            let decoder = JpegDecoder::new(cursor).map_err(|_| RasterError)?;
            finish_still(decoder)
        }
        ImageFormat::Png => {
            let decoder = PngDecoder::new(cursor).map_err(|_| RasterError)?;
            finish_still(decoder)
        }
        ImageFormat::Gif => {
            let decoder = GifDecoder::new(cursor).map_err(|_| RasterError)?;
            finish_still(decoder)
        }
        ImageFormat::WebP => {
            let decoder = WebPDecoder::new(cursor).map_err(|_| RasterError)?;
            finish_still(decoder)
        }
        _ => Err(RasterError),
    }
}

fn finish_still(decoder: impl ImageDecoder) -> Result<DynamicImage, RasterError> {
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > PIXEL_LIMIT {
        return Err(RasterError);
    }
    DynamicImage::from_decoder(decoder).map_err(|_| RasterError)
}

fn read_orientation(bytes: &[u8]) -> u32 {
    let mut cursor = Cursor::new(bytes);
    let Ok(exif) = exif::Reader::new().read_from_container(&mut cursor) else {
        return 1;
    };
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|field| field.value.get_uint(0))
        .filter(|value| (1..=8).contains(value))
        .unwrap_or(1)
}

fn apply_orientation(image: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => image.fliph(),
        3 => image.rotate180(),
        4 => image.flipv(),
        5 => image.rotate90().fliph(),
        6 => image.rotate90(),
        7 => image.rotate270().fliph(),
        8 => image.rotate270(),
        _ => image,
    }
}

fn encode_fitted(image: &DynamicImage, edge: u32) -> Result<Vec<u8>, RasterError> {
    let (width, height) = fit_inside(image.width(), image.height(), edge);
    let fitted = if width == image.width() && height == image.height() {
        image.clone()
    } else {
        image.resize_exact(width, height, image::imageops::FilterType::Lanczos3)
    };
    encode_webp(&fitted)
}

pub fn fit_inside(width: u32, height: u32, edge: u32) -> (u32, u32) {
    if width == 0 || height == 0 || edge == 0 {
        return (1, 1);
    }
    if width <= edge && height <= edge {
        return (width, height);
    }
    if width >= height {
        let out_h = (u64::from(height) * u64::from(edge) + u64::from(width) / 2) / u64::from(width);
        (edge, u32::try_from(out_h).unwrap_or(1).max(1))
    } else {
        let out_w =
            (u64::from(width) * u64::from(edge) + u64::from(height) / 2) / u64::from(height);
        (u32::try_from(out_w).unwrap_or(1).max(1), edge)
    }
}

fn encode_webp(image: &DynamicImage) -> Result<Vec<u8>, RasterError> {
    let rgba = image.to_rgba8();
    let mut output = Vec::new();
    WebPEncoder::new_lossless(&mut output)
        .encode(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(|_| RasterError)?;
    Ok(output)
}

fn is_avif(bytes: &[u8]) -> bool {
    if bytes.len() < 12 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    if matches!(&bytes[8..12], b"avif" | b"avis") {
        return true;
    }
    let size = u32::from_be_bytes(bytes[0..4].try_into().unwrap_or([0; 4])) as usize;
    let end = size.min(bytes.len());
    if end < 16 {
        return false;
    }
    bytes[16..end]
        .chunks_exact(4)
        .any(|brand| brand == b"avif" || brand == b"avis")
}

fn derive_avif(bytes: &[u8], edge: u32) -> Result<Vec<u8>, RasterError> {
    let extents = match ispe_extents(bytes) {
        Ok(extents) if !extents.is_empty() => extents,
        _ => {
            reject_avif(0, "ispe");
            return Err(RasterError);
        }
    };
    if extents
        .iter()
        .any(|(width, height)| !pixels_allowed(*width, *height))
    {
        reject_avif(0, "ispe");
        return Err(RasterError);
    }

    let parsed = mp4parse::read_avif(&mut Cursor::new(bytes), mp4parse::ParseStrictness::Normal)
        .map_err(|_| RasterError)?;
    let color = parsed
        .primary_item_coded_data()
        .ok_or(RasterError)?
        .to_vec();
    let alpha = parsed.alpha_item_coded_data().map(|bytes| bytes.to_vec());
    let rotation = parsed
        .image_rotation()
        .unwrap_or(mp4parse::ImageRotation::D0);
    let premultiplied = parsed.premultiplied_alpha;
    drop(parsed);

    let allocations = Arc::new(AtomicUsize::new(0));
    let picture = match decode_av1(color, &allocations) {
        Ok(picture) => picture,
        Err(error) => {
            reject_avif(
                allocations.load(Ordering::SeqCst),
                &format!("dav1d {error}"),
            );
            return Err(RasterError);
        }
    };
    if !eight_bit(&picture) || !pixels_allowed(picture.width(), picture.height()) {
        reject_avif(allocations.load(Ordering::SeqCst), "decoded-extent");
        return Err(RasterError);
    }
    let alpha_picture = if let Some(alpha) = alpha {
        match decode_av1(alpha, &allocations) {
            Ok(picture) => Some(picture),
            Err(error) => {
                reject_avif(
                    allocations.load(Ordering::SeqCst),
                    &format!("alpha {error}"),
                );
                return Err(RasterError);
            }
        }
    } else {
        None
    };
    let rgba = yuv_to_rgba(&picture, alpha_picture.as_ref(), premultiplied)?;
    let image = rotate_avif(DynamicImage::ImageRgba8(rgba), rotation);
    encode_fitted(&image, edge)
}

fn pixels_allowed(width: u32, height: u32) -> bool {
    width > 0 && height > 0 && u64::from(width) * u64::from(height) <= PIXEL_LIMIT
}

fn reject_avif(allocations: usize, reason: &str) {
    eprintln!("avif picture allocations={allocations} reason={reason}");
}

fn eight_bit<A: dav1d::PictureAllocator>(picture: &dav1d::Picture<A>) -> bool {
    picture.bits_per_component() == Some(dav1d::BitsPerComponent(8)) && picture.bit_depth() == 8
}

fn decode_av1(
    data: Vec<u8>,
    allocations: &Arc<AtomicUsize>,
) -> Result<dav1d::Picture<CountingAllocator>, dav1d::Error> {
    let mut settings = dav1d::Settings::new();
    settings.set_n_threads(1);
    settings.set_frame_size_limit(u32::try_from(PIXEL_LIMIT).unwrap_or(u32::MAX));
    let mut decoder = dav1d::Decoder::with_settings_and_allocator(
        &settings,
        CountingAllocator {
            calls: Arc::clone(allocations),
        },
    )?;
    let mut payload = Some(data);
    for _ in 0..8 {
        if let Some(buf) = payload.take() {
            match decoder.send_data(buf, None, None, None) {
                Ok(()) => {}
                Err(err) if err.is_again() => {}
                Err(err) => return Err(err),
            }
        } else {
            match decoder.send_pending_data() {
                Ok(()) => {}
                Err(err) if err.is_again() => {}
                Err(err) => return Err(err),
            }
        }
        match decoder.get_picture() {
            Ok(picture) => return Ok(picture),
            Err(err) if err.is_again() => continue,
            Err(err) => return Err(err),
        }
    }
    decoder.flush();
    decoder.get_picture()
}

#[derive(Debug)]
struct CountingAllocator {
    calls: Arc<AtomicUsize>,
}

unsafe impl dav1d::PictureAllocator for CountingAllocator {
    type AllocatorData = [Layout; 2];

    unsafe fn alloc_picture(
        &self,
        pic_params: &dav1d::PictureParameters,
    ) -> Result<dav1d::PictureAllocation<Self::AllocatorData>, dav1d::Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let product = u64::from(pic_params.width()) * u64::from(pic_params.height());
        if product == 0 || product > PIXEL_LIMIT || pic_params.bit_depth() != 8 {
            return Err(dav1d::Error::InvalidArgument);
        }

        fn align(value: usize) -> usize {
            value.div_ceil(128) * 128
        }
        let stride_mult = if pic_params.bit_depth() == 8 { 1 } else { 2 };
        let (stride, height) = match pic_params.pixel_layout() {
            dav1d::PixelLayout::I400 => (
                [align(pic_params.width() as usize) * stride_mult, 0],
                [align(pic_params.height() as usize), 0],
            ),
            dav1d::PixelLayout::I420 => (
                [
                    align(pic_params.width() as usize) * stride_mult,
                    align(pic_params.width().div_ceil(2) as usize) * stride_mult,
                ],
                [
                    align(pic_params.height() as usize),
                    align(pic_params.height().div_ceil(2) as usize),
                ],
            ),
            dav1d::PixelLayout::I422 => (
                [
                    align(pic_params.width() as usize) * stride_mult,
                    align(pic_params.width().div_ceil(2) as usize) * stride_mult,
                ],
                [
                    align(pic_params.height() as usize),
                    align(pic_params.height() as usize),
                ],
            ),
            dav1d::PixelLayout::I444 => (
                [
                    align(pic_params.width() as usize) * stride_mult,
                    align(pic_params.width() as usize) * stride_mult,
                ],
                [
                    align(pic_params.height() as usize),
                    align(pic_params.height() as usize),
                ],
            ),
        };
        let layout_0 = Layout::from_size_align(height[0] * stride[0], dav1d::PICTURE_ALIGNMENT)
            .map_err(|_| dav1d::Error::InvalidArgument)?;
        let data_0 = unsafe { alloc(layout_0) };
        if data_0.is_null() {
            return Err(dav1d::Error::NotEnoughMemory);
        }
        let (layout_1, data_1, data_2) = if stride[1] > 0 {
            let layout_1 =
                match Layout::from_size_align(height[1] * stride[1], dav1d::PICTURE_ALIGNMENT) {
                    Ok(layout) => layout,
                    Err(_) => {
                        unsafe { dealloc(data_0, layout_0) };
                        return Err(dav1d::Error::InvalidArgument);
                    }
                };
            let data_1 = unsafe { alloc(layout_1) };
            let data_2 = unsafe { alloc(layout_1) };
            if data_1.is_null() || data_2.is_null() {
                unsafe {
                    dealloc(data_0, layout_0);
                    if !data_1.is_null() {
                        dealloc(data_1, layout_1);
                    }
                    if !data_2.is_null() {
                        dealloc(data_2, layout_1);
                    }
                }
                return Err(dav1d::Error::NotEnoughMemory);
            }
            (layout_1, data_1, data_2)
        } else {
            (layout_0, std::ptr::null_mut(), std::ptr::null_mut())
        };
        Ok(dav1d::PictureAllocation {
            data: [data_0, data_1, data_2],
            stride: [stride[0] as isize, stride[1] as isize],
            allocator_data: [layout_0, layout_1],
        })
    }

    unsafe fn release_picture(&self, allocation: dav1d::PictureAllocation<Self::AllocatorData>) {
        unsafe {
            dealloc(allocation.data[0], allocation.allocator_data[0]);
            if !allocation.data[1].is_null() {
                dealloc(allocation.data[1], allocation.allocator_data[1]);
                dealloc(allocation.data[2], allocation.allocator_data[1]);
            }
        }
    }
}

fn yuv_to_rgba<A: dav1d::PictureAllocator>(
    picture: &dav1d::Picture<A>,
    alpha: Option<&dav1d::Picture<A>>,
    premultiplied: bool,
) -> Result<image::RgbaImage, RasterError> {
    let width = picture.width();
    let height = picture.height();
    let layout = picture.pixel_layout();
    let matrix = picture.matrix_coefficients();
    let full = picture.color_range() == dav1d::pixel::YUVRange::Full;
    let identity = matrix == dav1d::pixel::MatrixCoefficients::Identity;
    if identity && !matches!(layout, dav1d::PixelLayout::I400 | dav1d::PixelLayout::I444) {
        eprintln!("avif unsupported identity subsampling");
        return Err(RasterError);
    }
    let coefficients = if identity {
        None
    } else {
        Some(matrix_coefficients(matrix).ok_or_else(|| {
            eprintln!("avif unsupported matrix {matrix:?}");
            RasterError
        })?)
    };

    let y = picture.plane(dav1d::PlanarImageComponent::Y);
    let y_stride = picture.stride(dav1d::PlanarImageComponent::Y);
    let (u, v, chroma_stride) = if layout == dav1d::PixelLayout::I400 {
        (None, None, 0)
    } else {
        (
            Some(picture.plane(dav1d::PlanarImageComponent::U)),
            Some(picture.plane(dav1d::PlanarImageComponent::V)),
            picture.stride(dav1d::PlanarImageComponent::U),
        )
    };
    let alpha_plane = alpha.map(|picture| picture.plane(dav1d::PlanarImageComponent::Y));
    let alpha_stride = alpha
        .map(|picture| picture.stride(dav1d::PlanarImageComponent::Y))
        .unwrap_or(0);

    let mut rgba = Vec::with_capacity((width as usize) * (height as usize) * 4);
    for row in 0..height {
        for col in 0..width {
            let luma = sample(&y, y_stride, col, row)?;
            let (r, g, b) = if layout == dav1d::PixelLayout::I400 {
                (luma, luma, luma)
            } else if identity {
                let cb = sample(u.as_deref().unwrap_or(&[]), chroma_stride, col, row)?;
                let cr = sample(v.as_deref().unwrap_or(&[]), chroma_stride, col, row)?;
                (cr, luma, cb)
            } else {
                let (cx, cy) = chroma_point(layout, col, row);
                let cb = sample(u.as_deref().unwrap_or(&[]), chroma_stride, cx, cy)?;
                let cr = sample(v.as_deref().unwrap_or(&[]), chroma_stride, cx, cy)?;
                convert_yuv(luma, cb, cr, full, coefficients.unwrap())
            };
            let mut alpha_value = if let Some(plane) = &alpha_plane {
                sample(plane, alpha_stride, col, row)?
            } else {
                255
            };
            let (mut r, mut g, mut b) = (r, g, b);
            if premultiplied && alpha_value > 0 && alpha_value < 255 {
                r = ((u16::from(r) * 255) / u16::from(alpha_value)) as u8;
                g = ((u16::from(g) * 255) / u16::from(alpha_value)) as u8;
                b = ((u16::from(b) * 255) / u16::from(alpha_value)) as u8;
            } else if premultiplied && alpha_value == 0 {
                r = 0;
                g = 0;
                b = 0;
            }
            if alpha.is_none() {
                alpha_value = 255;
            }
            rgba.extend_from_slice(&[r, g, b, alpha_value]);
        }
    }
    image::RgbaImage::from_raw(width, height, rgba).ok_or(RasterError)
}

fn chroma_point(layout: dav1d::PixelLayout, x: u32, y: u32) -> (u32, u32) {
    match layout {
        dav1d::PixelLayout::I420 => (x / 2, y / 2),
        dav1d::PixelLayout::I422 => (x / 2, y),
        dav1d::PixelLayout::I444 | dav1d::PixelLayout::I400 => (x, y),
    }
}

fn sample(plane: &[u8], stride: u32, x: u32, y: u32) -> Result<u8, RasterError> {
    let index = (y as usize)
        .checked_mul(stride as usize)
        .and_then(|index| index.checked_add(x as usize))
        .ok_or(RasterError)?;
    plane.get(index).copied().ok_or(RasterError)
}

fn matrix_coefficients(matrix: dav1d::pixel::MatrixCoefficients) -> Option<(f32, f32)> {
    match matrix {
        dav1d::pixel::MatrixCoefficients::BT709 | dav1d::pixel::MatrixCoefficients::Unspecified => {
            Some((0.2126, 0.0722))
        }
        dav1d::pixel::MatrixCoefficients::BT470BG => Some((0.299, 0.114)),
        _ => None,
    }
}

fn convert_yuv(y: u8, cb: u8, cr: u8, full: bool, (kr, kb): (f32, f32)) -> (u8, u8, u8) {
    let (y, cb, cr) = if full {
        (f32::from(y), f32::from(cb) - 128.0, f32::from(cr) - 128.0)
    } else {
        (
            (f32::from(y) - 16.0) * (255.0 / 219.0),
            (f32::from(cb) - 128.0) * (255.0 / 224.0),
            (f32::from(cr) - 128.0) * (255.0 / 224.0),
        )
    };
    let kg = 1.0 - kr - kb;
    let r = y + 2.0 * (1.0 - kr) * cr;
    let b = y + 2.0 * (1.0 - kb) * cb;
    let g = y - (2.0 * kb * (1.0 - kb) / kg) * cb - (2.0 * kr * (1.0 - kr) / kg) * cr;
    (clamp_u8(r), clamp_u8(g), clamp_u8(b))
}

fn clamp_u8(value: f32) -> u8 {
    value.round().clamp(0.0, 255.0) as u8
}

fn rotate_avif(image: DynamicImage, rotation: mp4parse::ImageRotation) -> DynamicImage {
    match rotation {
        mp4parse::ImageRotation::D0 => image,
        mp4parse::ImageRotation::D90 => image.rotate270(),
        mp4parse::ImageRotation::D180 => image.rotate180(),
        mp4parse::ImageRotation::D270 => image.rotate90(),
    }
}

/// Local `ispe` reader. `ImageSpatialExtentsProperty` fields are private, and
/// `primary_item_coded_data` must not run before this check.
pub fn ispe_extents(bytes: &[u8]) -> Result<Vec<(u32, u32)>, ()> {
    let mut found = Vec::new();
    walk_boxes(bytes, &mut found)?;
    Ok(found)
}

fn walk_boxes(bytes: &[u8], found: &mut Vec<(u32, u32)>) -> Result<(), ()> {
    let mut offset = 0;
    while offset + 8 <= bytes.len() {
        let size32 = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap());
        let kind = &bytes[offset + 4..offset + 8];
        let (header, size) = if size32 == 1 {
            if offset + 16 > bytes.len() {
                return Err(());
            }
            let large = u64::from_be_bytes(bytes[offset + 8..offset + 16].try_into().unwrap());
            if large < 16 || large > (bytes.len() - offset) as u64 {
                return Err(());
            }
            (16usize, large as usize)
        } else if size32 == 0 {
            (8usize, bytes.len() - offset)
        } else {
            if size32 < 8 || size32 as usize > bytes.len() - offset {
                return Err(());
            }
            (8usize, size32 as usize)
        };
        let body = &bytes[offset + header..offset + size];
        match kind {
            b"ispe" => found.push(read_ispe(body)?),
            b"meta" => {
                if body.len() < 4 {
                    return Err(());
                }
                walk_boxes(&body[4..], found)?;
            }
            b"iprp" | b"ipco" | b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" | b"dinf"
            | b"edts" | b"udta" | b"meco" => walk_boxes(body, found)?,
            _ => {}
        }
        offset += size;
    }
    Ok(())
}

fn read_ispe(body: &[u8]) -> Result<(u32, u32), ()> {
    if body.len() < 12 || body[0] != 0 {
        return Err(());
    }
    Ok((
        u32::from_be_bytes(body[4..8].try_into().unwrap()),
        u32::from_be_bytes(body[8..12].try_into().unwrap()),
    ))
}

#[cfg(test)]
mod tests {
    use super::{fit_inside, ispe_extents, read_ispe};

    #[test]
    fn fit_matches_reviewed_edges() {
        assert_eq!(fit_inside(500, 400, 320), (320, 256));
        assert_eq!(fit_inside(1500, 3000, 2048), (1024, 2048));
        assert_eq!(fit_inside(48, 24, 2048), (48, 24));
        assert_eq!(fit_inside(24, 48, 2048), (24, 48));
        assert_eq!(fit_inside(8, 4, 2048), (8, 4));
    }

    #[test]
    fn ispe_walker_rejects_over_limit_and_reads_nested_boxes() {
        let ispe = {
            let mut body = vec![0, 0, 0, 0];
            body.extend(8u32.to_be_bytes());
            body.extend(4u32.to_be_bytes());
            box_of(b"ispe", &body)
        };
        let nested = box_of(
            b"meta",
            &[&[0, 0, 0, 0][..], &box_of(b"iprp", &box_of(b"ipco", &ispe))].concat(),
        );
        assert_eq!(ispe_extents(&nested).unwrap(), vec![(8, 4)]);

        let mut huge = vec![0, 0, 0, 0];
        huge.extend(4097u32.to_be_bytes());
        huge.extend(4097u32.to_be_bytes());
        assert!(read_ispe(&huge).unwrap().0 == 4097);
        assert!(u64::from(4097u32) * u64::from(4097u32) > super::PIXEL_LIMIT);
        assert!(ispe_extents(&[]).unwrap().is_empty());
        assert!(read_ispe(&[0, 0, 0, 0, 0, 0]).is_err());
    }

    fn box_of(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = ((8 + body.len()) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(body);
        out
    }
}
